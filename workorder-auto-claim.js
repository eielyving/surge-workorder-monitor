// Surge iOS 自动接工单与通知脚本
// 运行环境: Surge iOS 5.20+ Pro (支持 wake-system 与 cron)
// 目标系统: 供热客服派单系统 (http://www.lygr.net:9010/zhu2)
// 用户身份: 王信答 (userid: 2687, loginid: 18643724008)

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

  // 运行期限与工作时段判断 (每天 08:00 - 16:00，持续至 2027-12-31)
  if (dateStr > "2027-12-31") {
    console.log("[" + dateStr + " " + timeStr + "] 已超过设定期限 2027-12-31，脚本退出");
    $done();
    return;
  }

  var isWorkTime = (timeMinute >= 8 * 60 && timeMinute <= 16 * 60);

  // 本地持久化记录 (用于防重复接单)
  var STORE_KEY = "workorder_claimed_records_v1";
  var record = {};
  try {
    record = JSON.parse($persistentStore.read(STORE_KEY) || "{}");
  } catch (_) {
    record = {};
  }

  // 跨天重置已接单记录
  if (record.date !== dateStr) {
    record = { date: dateStr, claimedIds: [] };
  }
  if (!Array.isArray(record.claimedIds)) {
    record.claimedIds = [];
  }

  var claimedSet = {};
  record.claimedIds.forEach(function (id) {
    claimedSet[String(id)] = true;
  });

  // 查询工单接口 (个人工作台，包含未接单 Tab 1)
  var queryUrl = "http://www.lygr.net:9010/zhu2/app/weixin/myWork.jsp?xcflag=&loginid=18643724008&workType=&smallType=&bugbarstr=&bigid=";

  $httpClient.get({
    url: queryUrl,
    timeout: 10,
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
    }
  }, function (error, response, body) {
    if (error) {
      console.log("[" + dateStr + " " + timeStr + "] 查询失败(网络异常): " + String(error));
      $done();
      return;
    }
    if (!response || response.status < 200 || response.status >= 300) {
      console.log("[" + dateStr + " " + timeStr + "] 查询失败(HTTP状态码异常): " + (response ? response.status : "无响应"));
      $done();
      return;
    }

    var unassignedOrders = [];
    try {
      unassignedOrders = parseUnassignedOrders(body || "");
    } catch (e) {
      console.log("[" + dateStr + " " + timeStr + "] 解析工单异常: " + String(e.message || e));
      $done();
      return;
    }

    // 非工作时段 (例如夜间手动测试连通性)
    if (!isWorkTime) {
      console.log("[" + dateStr + " " + timeStr + "] [非工作时间自测] 供热系统网络正常，待抢工单数: " + unassignedOrders.length + " 件。08:00-16:00 将自动接单。");
      $done();
      return;
    }

    if (unassignedOrders.length === 0) {
      // 工作时段内无新工单，静默退出
      $done();
      return;
    }

    // 过滤出未处理过的待抢工单
    var toClaim = unassignedOrders.filter(function (order) {
      return order && order.id && !claimedSet[String(order.id)];
    });

    if (toClaim.length === 0) {
      $done();
      return;
    }

    console.log("[" + dateStr + " " + timeStr + "] 发现 " + toClaim.length + " 个待抢新工单，正在执行自动接单...");
    claimOrdersSequentially(toClaim, 0);
  });

  // 解析 myWork.jsp 中的 Tab 1 (未接单列表)
  function parseUnassignedOrders(html) {
    var q1Idx = html.indexOf("function query1(");
    if (q1Idx === -1) return [];
    var start = html.indexOf("var obj = [", q1Idx);
    if (start === -1) return [];
    var end = html.indexOf("][i];", start);
    if (end === -1) return [];
    var jsonStr = html.substring(start + "var obj = ".length, end + 1);
    var arr = JSON.parse(jsonStr);
    return Array.isArray(arr) ? arr : [];
  }

  // 顺序执行接单请求
  function claimOrdersSequentially(orders, index) {
    if (index >= orders.length) {
      // 保存当天接单记录
      $persistentStore.write(JSON.stringify(record), STORE_KEY);
      $done();
      return;
    }

    var order = orders[index];
    var workid = String(order.id);
    var telid = String(order.telid || "0");
    var username = "王信答";
    var userid = "2687";

    // 接单参数
    var postBody = "userid=" + encodeURIComponent(userid) +
                   "&workid=" + encodeURIComponent(workid) +
                   "&username=" + encodeURIComponent(username) +
                   "&telid=" + encodeURIComponent(telid) +
                   "&receiverRemark=&estimateStartTime=";

    var claimUrl = "http://www.lygr.net:9010/zhu2/weixin/jiedanWork.action";

    $httpClient.post({
      url: claimUrl,
      timeout: 10,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
      },
      body: postBody
    }, function (err, resp, data) {
      if (!err && resp && resp.status >= 200 && resp.status < 300) {
        console.log("[" + dateStr + " " + timeStr + "] 工单接单成功！单号: " + (order.workordernum || workid));
        
        // 记录已接单 ID
        record.claimedIds.push(workid);
        claimedSet[workid] = true;

        // 发送 iOS 系统锁屏通知
        var title = "【自动接单成功】" + (order.bigName || "工单") + " - " + (order.smallName || "");
        var subtitle = "单号: " + (order.workordernum || workid);
        var content = "目标: " + (order.taskObject || "未知") + "\n派单时间: " + (order.createTime || timeStr);

        if (typeof $notification !== "undefined" && $notification.post) {
          $notification.post(title, subtitle, content);
        }
      } else {
        console.log("[" + dateStr + " " + timeStr + "] 工单 " + workid + " 接单失败: " + String(err || (resp ? resp.status : "无响应")));
      }

      // 继续接取下一个 (如果有)
      claimOrdersSequentially(orders, index + 1);
    });
  }
})();
