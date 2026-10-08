/*
 * 진행 알림 — 서비스 워커에 붙는 작은 파일 (앱 0.2.3, 기획서 docs/plans/2026-10-08_player-mini-window-notification.md)
 * vite.config.ts의 workbox.importScripts로 자동 생성 서비스 워커(sw.js)에 붙는다.
 *
 * ⚠ 이 파일은 학생 기록을 **직접 바꾸지 않는다** (2026-10-08 선생님 결정: 명령 대기열).
 *   알림 버튼 ⏸·▶는 "언제 무엇을 눌렀는지"만 패드 저장소의 prefs.notifyQueue에 남기고 알림 모양을 바꾼다.
 *   기록 변경은 앱이 깨어날 때 눌린 시각 그대로 packages/core의 pause/play로 적용한다 (src/notify.ts drainNotifyQueue).
 *   → 기록을 쓰는 곳이 앱 하나뿐이라 봉인·전송 표시·제출한 주 잠금이 그대로 지켜진다.
 * ⚠ 알림 문구·버튼은 src/notify.ts의 notificationOptions와 같아야 한다 (두 곳을 함께 고칠 것).
 * 푸시(서버가 보내는 알림)는 쓰지 않는다 — 알림은 학생이 ▶를 누를 때 앱이 직접 띄운 것뿐.
 */

var SP_NOTIFY_TAG = "sp-progress";
var SP_PLAY_BODY = "쉬는 동안엔 ⏸ 일시정지, 끝나면 ⏹ 정지를 눌러 주세요";
var SP_PAUSE_BODY = "다시 하려면 ▶, 끝나면 ⏹를 눌러 주세요";

/** 앱과 같은 저장 공간 이름 — "/studyplanner/" → "studyplanner" (src/db.ts STORAGE_NAME) */
function spDbName() {
  var path = new URL(self.registration.scope).pathname.replace(/^\/+|\/+$/g, "");
  return path || "studyplanner";
}

/** 한국 시각의 날짜(YYYY-MM-DD)와 0시부터의 분 */
function spKstNow() {
  var iso = new Date(Date.now() + 9 * 3600000).toISOString();
  return { date: iso.slice(0, 10), minutes: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)) };
}

function spOptions(info, state, bodyOverride) {
  var playing = state === "playing";
  return {
    tag: SP_NOTIFY_TAG,
    body: bodyOverride || (playing ? SP_PLAY_BODY : SP_PAUSE_BODY),
    silent: true,
    renotify: false,
    requireInteraction: true,
    icon: "icons/icon-192.png",
    data: { state: state, planId: info.planId, date: info.date, label: info.label },
    actions: playing
      ? [{ action: "pause", title: "⏸ 일시정지" }, { action: "stop", title: "⏹ 정지" }]
      : [{ action: "play", title: "▶ 다시 시작" }, { action: "stop", title: "⏹ 정지" }],
  };
}

function spShow(info, state, bodyOverride) {
  var title = state === "playing" ? info.label : "일시정지 · " + info.label;
  return self.registration.showNotification(title, spOptions(info, state, bodyOverride));
}

/** 대기열에 명령 한 줄 남기기 (prefs 표의 notifyQueue 칸 — 저장소 구조는 바꾸지 않는다) */
function spEnqueue(item) {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open(spDbName());
    // 앱 저장소가 없으면 새로 만들지 않는다 (앱이 한 번도 안 열린 경우 — 알림이 있을 수 없음)
    request.onupgradeneeded = function () {
      request.transaction.abort();
    };
    request.onerror = function () {
      reject(request.error);
    };
    request.onsuccess = function () {
      var db = request.result;
      if (!db.objectStoreNames.contains("prefs")) {
        db.close();
        reject(new Error("prefs 표가 없습니다"));
        return;
      }
      var tx = db.transaction("prefs", "readwrite");
      var store = tx.objectStore("prefs");
      var get = store.get("notifyQueue");
      get.onsuccess = function () {
        var row = get.result && Array.isArray(get.result.items) ? get.result : { key: "notifyQueue", items: [] };
        row.items.push(item);
        store.put(row);
      };
      tx.oncomplete = function () {
        db.close();
        resolve();
      };
      tx.onerror = function () {
        db.close();
        reject(tx.error);
      };
    };
  });
}

function spTellClients(message) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    list.forEach(function (client) {
      client.postMessage(message);
    });
  });
}

/** 앱 열기 — 이미 열려 있으면 앞으로 가져와 알리고, 없으면 새로 연다 */
function spOpenApp(params) {
  var scope = self.registration.scope;
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    var client = list.find(function (c) {
      return c.url.indexOf(scope) === 0;
    });
    if (client) {
      // 먼저 알리고 앞으로 가져온다 — 앞으로 가져오기가 막혀도(브라우저 정책) 앱은 화면을 바꿔 둔다
      client.postMessage({ type: "sp-notify-open", notify: params.notify, plan: params.plan || null });
      return client.focus().catch(function () {});
    }
    var url = new URL(scope);
    url.searchParams.set("notify", params.notify);
    if (params.plan) url.searchParams.set("plan", params.plan);
    return self.clients.openWindow(url.href);
  });
}

function spId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** 알림 버튼 ⏸·▶ — 앱을 열지 않고 그 자리에서 */
function spToggle(notification, action) {
  var info = notification.data || {};
  var now = Date.now();
  if (action === "pause") {
    if (info.state !== "playing") return spShow(info, info.state || "paused");
    return spEnqueue({ id: spId(), type: "pause", at: now, planId: info.planId })
      .then(function () {
        return spShow(info, "paused");
      })
      .then(function () {
        return spTellClients({ type: "sp-notify-queue" });
      });
  }
  // ▶ 다시 시작 — 앱의 재생 조건 중 알림에서 알 수 있는 것을 먼저 본다 (나머지는 앱이 적용할 때 다시 검사)
  if (info.state === "playing") return spShow(info, "playing");
  var kst = spKstNow();
  if (kst.date !== info.date) {
    return spShow(info, "paused", "오늘 계획이 아니에요. 앱을 열어 오늘로 옮긴 뒤 ▶를 눌러 주세요.");
  }
  if (kst.minutes < 7 * 60) {
    return spShow(info, "paused", "기록은 7시부터 24시까지만 할 수 있어요.");
  }
  return spEnqueue({ id: spId(), type: "play", at: now, planId: info.planId })
    .then(function () {
      return spShow(info, "playing");
    })
    .then(function () {
      return spTellClients({ type: "sp-notify-queue" });
    });
}

self.addEventListener("notificationclick", function (event) {
  var notification = event.notification;
  if (notification.tag !== SP_NOTIFY_TAG) return;
  var action = event.action;
  if (action === "pause" || action === "play") {
    event.waitUntil(
      spToggle(notification, action).catch(function () {
        // 대기열에 못 남기면 앱을 열어 직접 누르게 한다
        return spOpenApp({ notify: "today" });
      }),
    );
    return;
  }
  var info = notification.data || {};
  // ⏹ 정지: 앱을 열어 확인창 (선생님 결정 — 완수는 되돌리기 어려움) / 알림 본체: 오늘 계획 화면
  event.waitUntil(spOpenApp(action === "stop" ? { notify: "stop", plan: info.planId } : { notify: "today" }));
});
