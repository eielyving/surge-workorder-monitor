// Read-only work-order monitor for Surge iOS.
// This script never claims an order, sends a reply, or logs personal order fields.

(function () {
  var now = new Date(Date.now() + 8 * 60 * 60 * 1000); // Asia/Shanghai, independent of device timezone
  var year = now.getUTCFullYear();
  var month = String(now.getUTCMonth() + 1).padStart(2, "0");
  var dayOfMonth = String(now.getUTCDate()).padStart(2, "0");
  var date = year + "-" + month + "-" + dayOfMonth;
  var minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  var hm = String(now.getUTCHours()).padStart(2, "0") + ":" + String(now.getUTCMinutes()).padStart(2, "0");

  // Cron has no end-year field; after 2027-12-31 this guard prevents further business-system requests.
  if (date > "2027-12-31" || minuteOfDay < 8 * 60 || minuteOfDay > 16 * 60) {
    $done();
    return;
  }

  function writeStatus(summary, isError) {
    var key = "workorder-monitor-status";
    var previous = {};
    try {
      previous = JSON.parse($persistentStore.read(key) || "{}");
    } catch (_) {}

    var nowMs = Date.now();
    var changed = previous.date !== date || previous.summary !== summary || previous.isError !== isError;
    var heartbeatDue = !previous.loggedAt || nowMs - previous.loggedAt >= 15 * 60 * 1000;
    if (changed || heartbeatDue) {
      console.log("[" + date + " " + hm + "] " + (isError ? "ERROR " : "OK ") + summary);
      $persistentStore.write(JSON.stringify({
        date: date,
        summary: summary,
        isError: isError,
        loggedAt: nowMs
      }), key);
    }
  }

  function finishWithError(message) {
    writeStatus(message, true);
    $done();
  }

  function parseOrders(body) {
    var match = /var\s+obj\s*=\s*(\[[\s\S]*?\])\s*\[i\]\s*;/i.exec(body) ||
      /var\s+obj\s*=\s*(\[[\s\S]*?\])\s*;/i.exec(body);
    if (!match) throw new Error("response did not contain the expected order array");
    var orders = JSON.parse(match[1]);
    if (!Array.isArray(orders)) throw new Error("parsed order data was not an array");
    return orders;
  }

  function summarize(orders) {
    var states = {};
    var categories = {};
    orders.forEach(function (order) {
      var state = order.state == null || order.state === "" ? "(empty)" : String(order.state);
      states[state] = (states[state] || 0) + 1;
      var category = [order.bigName, order.smallName].filter(Boolean).join("/") || "(unknown)";
      categories[category] = (categories[category] || 0) + 1;
    });
    return JSON.stringify({ total: orders.length, states: states, categories: categories });
  }

  var params = {
    startTime: date,
    endTime: date,
    state: "",
    type: "", // empty type is intended to request all work-order types
    smallname: "",
    group1: "仙城供暖公司",
    group2: "",
    txt_bugbar: "",
    taskObject: "",
    remark: ""
  };
  var query = Object.keys(params).map(function (key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(params[key]);
  }).join("&");
  var url = "http://www.lygr.net:9010/zhu2/app/weixin/query.jsp?" + query;

  $httpClient.get({
    url: url,
    timeout: 10,
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
    }
  }, function (error, response, body) {
    if (error) {
      finishWithError("query failed: " + String(error));
      return;
    }
    if (!response || response.status < 200 || response.status >= 300) {
      finishWithError("query returned HTTP " + (response ? response.status : "no response"));
      return;
    }
    try {
      var orders = parseOrders(body || "");
      writeStatus(summarize(orders), false);
      $done();
    } catch (e) {
      finishWithError("parse failed: " + String(e && e.message ? e.message : e));
    }
  });
})();
