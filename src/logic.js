// The pure parts of main.js's most delicate logic, with the side effects (timers, the
// detector, saving) passed in, so tests/web/logic.test.cjs can run them in Node.
//
// Loaded by index.html before main.js (a global `BirdsLogic`) and by the Node tests (require).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BirdsLogic = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The word after the count. `t` looks a key up in the current language's strings.
  function birdsSuffix(value, lang, t) {
    if (lang === "pl") {
      const n = Math.abs(Math.trunc(value));
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (n === 1) return t("count_suffix_one");
      if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
        return t("count_suffix_few");
      }
      return t("count_suffix_many");
    }
    if (Number(value) === 1) return t("count_suffix_one");
    return t("count_suffix");
  }

  // Counting that follows the settings: `schedule` waits `delay` ms after the last call, and
  // calls arriving while `process` (async) is running are coalesced into one more run.
  // `canSchedule()` is checked when scheduling, `canRun()` when a run starts.
  function createProcessScheduler({
    process,
    canRun,
    canSchedule = canRun,
    delay = 100,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    let isProcessing = false;
    let pending = false;
    let timer = null;

    async function run() {
      if (!canRun()) return;
      if (isProcessing) {
        pending = true;
        return;
      }
      isProcessing = true;
      try {
        await process();
      } finally {
        isProcessing = false;
        if (pending) {
          pending = false;
          run();
        }
      }
    }

    function schedule() {
      if (!canSchedule()) return;
      if (timer) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        run();
      }, delay);
    }

    // Forgets a waiting call and a coalesced one; a run in progress carries on.
    function cancel() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      pending = false;
    }

    return { schedule, run, cancel };
  }

  // Saves of history entries, one after another, so the first save's id is known to the next.
  // `savedKeys` remembers per editing session what was saved last, to skip saves that change
  // nothing.
  function createHistorySaveQueue() {
    const savedKeys = new Map();
    let chain = Promise.resolve();

    // Queues `task` (async; returns false for a save that did not happen) for `session`.
    // Skipped, returning false, when `key` is what was saved last for the session and
    // `force` is not set. A failed save is forgotten, so the next one retries, and `onUndo`
    // runs.
    function enqueue({ session, key, force = false, task, onUndo, onError }) {
      if (!force && savedKeys.get(session) === key) return false;
      savedKeys.set(session, key);
      const undo = () => {
        if (savedKeys.get(session) === key) savedKeys.delete(session);
        if (onUndo) onUndo();
      };
      chain = chain
        .then(async () => {
          if ((await task()) === false) undo();
        })
        .catch((e) => {
          undo();
          if (onError) onError(e);
        });
      return true;
    }

    return {
      enqueue,
      markSaved: (session, key) => savedKeys.set(session, key),
      savedKey: (session) => savedKeys.get(session),
      // Resolves when everything queued so far is done.
      flush: () => chain,
    };
  }

  return { birdsSuffix, createProcessScheduler, createHistorySaveQueue };
});
