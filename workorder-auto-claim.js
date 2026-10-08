// Surge iOS 自动接工单与通知脚本 (增强版)
// 运行环境: Surge iOS 5.20+ Pro (支持 wake-system 与 cron)
// 目标系统: 供热客服派单系统 (http://www.lygr.net:9010/zhu2)

(function () {
  // 强制按北京时间 (UTC+8) 计算
  var now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  var year = now.getUTCFullYear();
  var month = String(now.getUTCMonth() + 1).padStart(2, "0");
  var day = String(now.getUTCDate()).padStart(2, "0");
  var dateStr = year + "-" + month + "-" + day;
  var hour = now.getUTCHours();
  var minute = now.getUTCMinutes();
  var timeMinute = hour * 60 + minute;
  var timeStr = String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");

  // 1. 运行期限判断 (持续至 2027-12-31)
  if (dateStr > "2027-12-31") {
    console.log("[" + dateStr + " " + timeStr + "] 已超过设定期限 2027-12-31，脚本退出");
    $done();
    return;
  }

  var isWorkTime = (timeMinute >= 8 * 60 && timeMinute <= 16 * 60);

  // 2. 解析身份参数并做有效性校验
  var params = parseArguments();
  if (isInvalidParam(params.loginid) || isInvalidParam(params.userid) || isInvalidParam(params.username)) {
    var errConfig = "未检测到有效身份参数配置。请在 Surge 模块配置中填入实际的 loginid、userid、username！";
    console.log("[" + dateStr + " " + timeStr + "] " + errConfig);
    if (isWorkTime && typeof $notification !== "undefined" && $notification.post) {
      $notification.post("【工单脚本配置提示】", "缺少有效用户身份参数", errConfig);
    }
    $done();
    return;
  }

  // 3. 本地持久化去重与待确认状态记录 (防 null 崩溃校验)
  var STORE_KEY = "workorder_claimed_records_v1";
  var record = {};
  try {
    var rawStore = $persistentStore.read(STORE_KEY);
    record = rawStore ? JSON.parse(rawStore) : {};
  } catch (_) {
    record = {};
  }
  if (!record || typeof record !== "object") {
    record = {};
  }

  // 跨天自动重置
  if (record.date !== dateStr) {
    record = { date: dateStr, claimedIds: [], pendingVerifyOrders: {} };
  }
  if (!Array.isArray(record.claimedIds)) {
    record.claimedIds = [];
  }
  if (!record.pendingVerifyOrders || typeof record.pendingVerifyOrders !== "object") {
    record.pendingVerifyOrders = {};
  }

  var claimedSet = {};
  record.claimedIds.forEach(function (id) {
    claimedSet[String(id)] = true;
  });

  // 4. 查询个人工作台（单次超时 5 秒，支持 1 秒延迟自动重试 1 次）
  var queryUrl = "http://www.lygr.net:9010/zhu2/app/weixin/myWork.jsp?xcflag=&loginid=" +
                 encodeURIComponent(params.loginid) +
                 "&workType=&smallType=&bugbarstr=&bigid=";

  fetchWorkBenchWithRetry(1, 2, function (body) {
    // 5. 解析未接单列表 (query1) 与 处理中列表 (query2)
    var unassignedOrders = null;
    var inProgressOrders = [];
    try {
      unassignedOrders = parseTabOrders(body || "", "query1");
      inProgressOrders = parseTabOrders(body || "", "query2");
    } catch (e) {
      var parseErrMsg = "页面结构匹配失败: " + String(e.message || e);
      console.log("[" + dateStr + " " + timeStr + "] 【解析异常警告】" + parseErrMsg);
      if (isWorkTime && typeof $notification !== "undefined" && $notification.post) {
        $notification.post("【工单页面结构异常】", "未能识别工单数据", parseErrMsg + "，请检查系统是否改版");
      }
      $done();
      return;
    }

    // 将已在“处理中”的工单加入内存去重集合
    inProgressOrders.forEach(function (item) {
      if (item && item.id) {
        claimedSet[String(item.id)] = true;
      }
    });

    // 6. 恢复核验：检查此前因断网暂存的“待确认工单”，补发状态恢复通知
    resolvePendingVerifications(unassignedOrders, inProgressOrders);

    // 非工作时段 (如夜间手动测试)
    if (!isWorkTime) {
      console.log("[" + dateStr + " " + timeStr + "] [非工作时间自测] 供热系统连通正常，身份: " + params.username + "，当前待接工单数: " + unassignedOrders.length + " 件。08:00-16:00 将开启自动接单。");
      $done();
      return;
    }

    if (unassignedOrders.length === 0) {
      // 工作时段内正常且无待接工单，静默退出
      $done();
      return;
    }

    // 过滤掉今天已接过的工单，并在本轮数据内按工单ID严格去重
    var seenBatchIds = {};
    var toClaim = [];
    unassignedOrders.forEach(function (order) {
      if (!order || !order.id) return;
      var wid = String(order.id);
      if (!claimedSet[wid] && !seenBatchIds[wid]) {
        seenBatchIds[wid] = true;
        toClaim.push(order);
      }
    });

    if (toClaim.length === 0) {
      $done();
      return;
    }

    // FIFO 排序：将时间解析为数值毫秒时间戳，按最早派单优先排序
    toClaim.sort(function (a, b) {
      var timeA = getOrderTimestamp(a);
      var timeB = getOrderTimestamp(b);
      if (timeA !== timeB) {
        return timeA - timeB; // 升序：最早派发的排在最前
      }
      // 时间相同或缺失时，按工单ID作确定性排序
      var idA = parseInt(a.id, 10) || String(a.id || "");
      var idB = parseInt(b.id, 10) || String(b.id || "");
      if (typeof idA === "number" && typeof idB === "number") {
        return idA - idB;
      }
      return String(idA).localeCompare(String(idB));
    });

    // 批次容量控制：单轮最多处理 2 张工单（网络最坏耗时~43秒，远小于总时限75秒）
    var MAX_BATCH = 2;
    var totalCount = toClaim.length;
    if (totalCount > MAX_BATCH) {
      toClaim = toClaim.slice(0, MAX_BATCH);
      console.log("[" + dateStr + " " + timeStr + "] 共有 " + totalCount + " 个待接新工单，已按派单时间先后排序，本轮优先处理最早派单的 " + MAX_BATCH + " 个，剩余将在下次轮询顺延接取。");
    } else {
      console.log("[" + dateStr + " " + timeStr + "] 发现 " + totalCount + " 个待接新工单，正在按派单时间先后执行接单与二次确认...");
    }

    processOrdersSequentially(toClaim, 0);
  });

  // 安全提取工单派单毫秒时间戳（用于严格单调的 FIFO 排序）
  function getOrderTimestamp(order) {
    if (!order) return Infinity;

    // 1. 尝试从 createTime 解析 (常见格式: "2026-10-08 08:45:34" 或 "2026/10/08 08:45:34")
    if (order.createTime && typeof order.createTime === "string") {
      var s = order.createTime.trim().replace(/-/g, "/");
      var t = Date.parse(s);
      if (!isNaN(t)) {
        return t;
      }
      // 仅有时间部分 (如 "08:45" 或 "08:45:34")
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(order.createTime.trim())) {
        var parts = order.createTime.trim().split(":");
        var todayT = Date.parse(dateStr.replace(/-/g, "/") + " " + parts[0] + ":" + parts[1] + ":" + (parts[2] || "00"));
        if (!isNaN(todayT)) {
          return todayT;
        }
      }
    }

    // 2. 尝试从工单号 workordernum 提取年月日时分秒时间戳 (如 "GD20261008084534141" 中提取 20261008084534)
    if (order.workordernum && typeof order.workordernum === "string") {
      var m = order.workordernum.match(/\d{14}/);
      if (m) {
        var str = m[0];
        var y = str.substring(0, 4);
        var mo = str.substring(4, 6);
        var d = str.substring(6, 8);
        var h = str.substring(8, 10);
        var mi = str.substring(10, 12);
        var se = str.substring(12, 14);
        var tNum = Date.parse(y + "/" + mo + "/" + d + " " + h + ":" + mi + ":" + se);
        if (!isNaN(tNum)) {
          return tNum;
        }
      }
    }

    // 3. 缺失时间信息的工单统一排在最后
    return Infinity;
  }

  // 检查并核验此前断网暂存的待确认工单，恢复发送通知
  function resolvePendingVerifications(unassignedList, inProgressList) {
    var pendingKeys = Object.keys(record.pendingVerifyOrders || {});
    if (pendingKeys.length === 0) return;

    var changed = false;
    pendingKeys.forEach(function (wid) {
      var pending = record.pendingVerifyOrders[wid];
      if (!pending) return;

      var inProgress = inProgressList.some(function (item) {
        return item && String(item.id) === String(wid);
      });

      if (inProgress) {
        // 成功自愈：服务端实际已成功进入处理中！
        console.log("[" + dateStr + " " + timeStr + "] 待确认工单 " + wid + " 已在服务端'处理中'列表中核验确认！补发成功通知");
        record.claimedIds.push(wid);
        claimedSet[wid] = true;
        delete record.pendingVerifyOrders[wid];
        changed = true;

        var title = "【自动接单恢复确认成功】" + (pending.bigName || "工单") + " - " + (pending.smallName || "");
        var subtitle = "单号: " + (pending.workordernum || wid);
        var content = "网络恢复核验: 此前接单已成功入库！\n目标: " + (pending.taskObject || "未知") + "\n派单时间: " + (pending.createTime || timeStr);

        if (typeof $notification !== "undefined" && $notification.post) {
          $notification.post(title, subtitle, content);
        }
        return;
      }

      var stillUnassigned = unassignedList.some(function (item) {
        return item && String(item.id) === String(wid);
      });

      if (stillUnassigned) {
        // 未接单列表中依然存在：说明此前断网时的接单请求确实未被服务端成功执行，移出暂存以便本轮重新接单
        console.log("[" + dateStr + " " + timeStr + "] 待确认工单 " + wid + " 仍在未接单列表中，此前POST未成功，移出待确认队列允许重新接单");
        delete record.pendingVerifyOrders[wid];
        changed = true;
        return;
      }

      // 既不在未接单，也不在处理中：可能已被调度取消或他人处理
      console.log("[" + dateStr + " " + timeStr + "] 待确认工单 " + wid + " 已不在系统中，移出待确认队列");
      delete record.pendingVerifyOrders[wid];
      changed = true;
      if (typeof $notification !== "undefined" && $notification.post) {
        $notification.post("【工单状态核验】", "工单 " + (pending.workordernum || wid), "工单已不在系统中，可能已被取消或撤回");
      }
    });

    if (changed) {
      try {
        $persistentStore.write(JSON.stringify(record), STORE_KEY);
      } catch (_) {}
    }
  }

  // 工作台 GET 查询（单次超时 5 秒，带单次 1 秒延迟自动重试逻辑）
  function fetchWorkBenchWithRetry(attempt, maxAttempts, onSuccess) {
    $httpClient.get({
      url: queryUrl,
      timeout: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
      }
    }, function (error, response, body) {
      if (error || !response || response.status < 200 || response.status >= 300) {
        var failDesc = error ? String(error) : ("HTTP " + (response ? response.status : "无响应"));
        if (attempt < maxAttempts) {
          console.log("[" + dateStr + " " + timeStr + "] 工作台查询初次异常 (" + failDesc + ")，1秒后自动重试...");
          var retryFn = function () {
            fetchWorkBenchWithRetry(attempt + 1, maxAttempts, onSuccess);
          };
          if (typeof setTimeout === "function") {
            setTimeout(retryFn, 1000);
          } else {
            retryFn();
          }
          return;
        }

        // 连续重试失败，记录并上报通知
        var netErr = "网络请求失败: " + failDesc;
        console.log("[" + dateStr + " " + timeStr + "] " + netErr + " (已重试)");
        if (isWorkTime && typeof $notification !== "undefined" && $notification.post) {
          $notification.post("【工单网络异常】", "连接供热系统失败 (重试无效)", netErr);
        }
        $done();
        return;
      }

      onSuccess(body);
    });
  }

  // 解析 myWork.jsp 中指定函数对应的工单数组 (query1=未接单, query2=处理中)
  function parseTabOrders(html, funcName) {
    if (!html || typeof html !== "string") {
      throw new Error("页面响应为空");
    }
    if (html.indexOf("处理的工单") === -1 && html.indexOf("myWork") === -1 && html.indexOf(funcName) === -1) {
      throw new Error("响应非预期工单页面(缺少处理的工单标识)");
    }
    var fnIdx = html.indexOf("function " + funcName + "(");
    if (fnIdx === -1) {
      throw new Error("未定位到函数 " + funcName);
    }
    var start = html.indexOf("var obj = [", fnIdx);
    if (start === -1) {
      throw new Error("未定位到工单数据起始标记 (var obj = [)");
    }
    var end = html.indexOf("][i];", start);
    if (end === -1) {
      throw new Error("未定位到工单数据结束标记 (][i];)");
    }
    var jsonStr = html.substring(start + "var obj = ".length, end + 1);
    var arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) {
      throw new Error("解析出的工单数据非数组格式");
    }
    return arr;
  }

  // 顺序执行接单，并进行“系统状态二次核实闭环”
  function processOrdersSequentially(orders, index) {
    if (index >= orders.length) {
      $done();
      return;
    }

    var order = orders[index];
    var workid = String(order.id);
    var telid = String(order.telid || "0");

    // 防御性检查：若该工单已在本轮处理中被标记接单，直接跳过避免重复 POST
    if (claimedSet[workid]) {
      processOrdersSequentially(orders, index + 1);
      return;
    }

    var postBody = "userid=" + encodeURIComponent(params.userid) +
                   "&workid=" + encodeURIComponent(workid) +
                   "&username=" + encodeURIComponent(params.username) +
                   "&telid=" + encodeURIComponent(telid) +
                   "&receiverRemark=&estimateStartTime=";

    var claimUrl = "http://www.lygr.net:9010/zhu2/weixin/jiedanWork.action";

    // 第一步：发送接单 POST 请求 (超时 5 秒)
    $httpClient.post({
      url: claimUrl,
      timeout: 5,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
      },
      body: postBody
    }, function (err, resp, data) {
      var postErr = (err || !resp || resp.status < 200 || resp.status >= 300)
        ? (err ? String(err) : ("HTTP " + (resp ? resp.status : "无响应")))
        : null;

      if (postErr) {
        console.log("[" + dateStr + " " + timeStr + "] 工单 " + workid + " POST 请求响应异常 (" + postErr + ")，立即发起状态核对确认服务端入库结果...");
      }

      // 第二步：无论 POST 是否报错，均向系统发起二次查询核实（确认该工单是否真实进入“处理中(Tab 2)”）
      verifyClaimSuccess(workid, function (verified, reason, isNetworkUncertain) {
        if (verified) {
          console.log("[" + dateStr + " " + timeStr + "] 工单接单状态核实成功！单号: " + (order.workordernum || workid) + (postErr ? " (注: POST网络虽有波动但服务端已成功接单)" : ""));

          // 逐单即时持久化，若之前在 pending 队列中一并清除
          record.claimedIds.push(workid);
          claimedSet[workid] = true;
          if (record.pendingVerifyOrders && record.pendingVerifyOrders[workid]) {
            delete record.pendingVerifyOrders[workid];
          }
          try {
            var saveOk = $persistentStore.write(JSON.stringify(record), STORE_KEY);
            if (!saveOk) {
              console.log("[" + dateStr + " " + timeStr + "] 【持久化警告】$persistentStore.write 返回失败");
            }
          } catch (eStore) {
            console.log("[" + dateStr + " " + timeStr + "] 【持久化异常】" + eStore.message);
          }

          // 状态百分之百确认后，才发送成功的系统锁屏通知
          var title = "【自动接单成功】" + (order.bigName || "工单") + " - " + (order.smallName || "");
          var subtitle = "单号: " + (order.workordernum || workid);
          var content = "目标: " + (order.taskObject || "未知") + "\n派单时间: " + (order.createTime || timeStr);

          if (typeof $notification !== "undefined" && $notification.post) {
            $notification.post(title, subtitle, content);
          }
        } else if (isNetworkUncertain) {
          // 复核请求网络连续中断或解析异常，保存到持久化 pending 队列，供后续轮询自愈
          console.log("[" + dateStr + " " + timeStr + "] 工单 " + workid + " 状态核验网络受阻，加入待确认队列: " + reason);
          record.pendingVerifyOrders[workid] = {
            workid: workid,
            workordernum: order.workordernum || workid,
            bigName: order.bigName || "工单",
            smallName: order.smallName || "",
            taskObject: order.taskObject || "未知",
            createTime: order.createTime || timeStr
          };
          try {
            $persistentStore.write(JSON.stringify(record), STORE_KEY);
          } catch (_) {}

          if (typeof $notification !== "undefined" && $notification.post) {
            $notification.post("【接单状态待确认】", "工单 " + (order.workordernum || workid), "接单已发出但网络异常无法核对状态，已加入待确认队列，将在下个周期自动核验并补发通知");
          }
        } else {
          var failSummary = postErr ? ("网络响应异常(" + postErr + ") 且 " + reason) : reason;
          console.log("[" + dateStr + " " + timeStr + "] 工单 " + workid + " 接单未确认: " + failSummary);
          if (typeof $notification !== "undefined" && $notification.post) {
            $notification.post("【接单未成功】", "工单 " + (order.workordernum || workid), failSummary);
          }
        }

        // 处理下一张工单
        processOrdersSequentially(orders, index + 1);
      });
    });
  }

  // 二次查询核实工单是否已进入“处理中”列表 (Tab 2)，单次超时 5 秒，带单次 1 秒延迟自动重试
  function verifyClaimSuccess(targetWorkId, callback) {
    function doVerify(attempt) {
      $httpClient.get({
        url: queryUrl,
        timeout: 5,
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
        }
      }, function (err, resp, body) {
        if (err || !resp || resp.status !== 200 || !body) {
          var errTxt = err ? String(err) : ("HTTP " + (resp ? resp.status : "无响应"));
          if (attempt < 2) {
            console.log("[" + dateStr + " " + timeStr + "] 工单 " + targetWorkId + " 状态复核初次请求异常 (" + errTxt + ")，1秒后自动重试核验...");
            var retryFn = function () {
              doVerify(attempt + 1);
            };
            if (typeof setTimeout === "function") {
              setTimeout(retryFn, 1000);
            } else {
              retryFn();
            }
            return;
          }
          callback(false, "核实请求连续网络异常(" + errTxt + ")", true);
          return;
        }

        try {
          var inProgressOrders = parseTabOrders(body, "query2");
          var matched = inProgressOrders.some(function (item) {
            return item && String(item.id) === String(targetWorkId);
          });

          if (matched) {
            callback(true, "已确认存在于处理中列表", false);
            return;
          }

          // 若不在处理中，核查是否仍在未接单列表
          var unassigned = parseTabOrders(body, "query1");
          var stillPending = unassigned.some(function (item) {
            return item && String(item.id) === String(targetWorkId);
          });

          if (stillPending) {
            callback(false, "工单仍在未接单列表中，接单请求未被服务端执行", false);
          } else {
            callback(false, "工单不在处理中列表，亦不在未接单列表", false);
          }
        } catch (eParse) {
          // 若解析结构异常，判定为网络不确定（可能返回了截断的 HTML），避免直接报失败
          callback(false, "核实解析异常: " + eParse.message, true);
        }
      });
    }

    doVerify(1);
  }

  // 校验参数是否属于无效占位符或空值
  function isInvalidParam(val) {
    if (!val || typeof val !== "string") return true;
    var s = val.trim();
    if (!s) return true;
    if (s.indexOf("{") !== -1 || s.indexOf("}") !== -1) return true;
    if (/登录|手机|用户|ID|员工|姓名|YOUR_|default/i.test(s)) return true;
    return false;
  }

  // 解析 Surge $argument 参数
  function parseArguments() {
    var res = { loginid: "", userid: "", username: "" };
    var raw = (typeof $argument !== "undefined" && $argument) ? String($argument).trim() : "";
    if (raw) {
      raw.split("&").forEach(function (pair) {
        var idx = pair.indexOf("=");
        if (idx !== -1) {
          var k = pair.substring(0, idx).trim();
          var v = pair.substring(idx + 1).trim();
          if (k && v && !isInvalidParam(v)) {
            try {
              res[k] = decodeURIComponent(v);
            } catch (_) {
              res[k] = v;
            }
          }
        }
      });
    }

    // 本地持久化兜底（如果用户之前本地存过）
    if (!res.loginid && typeof $persistentStore !== "undefined") {
      res.loginid = $persistentStore.read("workorder_loginid") || "";
    }
    if (!res.userid && typeof $persistentStore !== "undefined") {
      res.userid = $persistentStore.read("workorder_userid") || "";
    }
    if (!res.username && typeof $persistentStore !== "undefined") {
      res.username = $persistentStore.read("workorder_username") || "";
    }
    return res;
  }
})();
