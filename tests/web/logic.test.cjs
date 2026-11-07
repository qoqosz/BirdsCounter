// Tests of src/logic.js: the count's Polish plurals, the debounce and coalescing of counting,
// and the chaining of history saves. No OpenCV.js needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { birdsSuffix, createProcessScheduler, createHistorySaveQueue } = require("../../src/logic.js");

// Resolves after the pending promise callbacks have run.
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A controllable clock for setTimer/clearTimer.
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    get count() {
      return timers.size;
    },
  };
}

// A promise that is resolved or rejected from outside.
function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

const strings = {
  count_suffix_one: "one",
  count_suffix_few: "few",
  count_suffix_many: "many",
  count_suffix: "other",
};
const t = (key) => strings[key];

test("Polish plurals", () => {
  const pl = (n) => birdsSuffix(n, "pl", t);
  assert.equal(pl(1), "one");
  for (const n of [2, 3, 4, 22, 23, 24, 32, 102, 104]) assert.equal(pl(n), "few", String(n));
  for (const n of [0, 5, 9, 10, 11, 12, 13, 14, 15, 19, 20, 21, 25, 26, 100, 101, 111, 112, 113, 114, 115]) {
    assert.equal(pl(n), "many", String(n));
  }
  assert.equal(pl(-2), "few");
  assert.equal(pl(2.9), "few");
});

test("English plurals", () => {
  const en = (n) => birdsSuffix(n, "en", t);
  assert.equal(en(1), "one");
  for (const n of [0, 2, 3, 5, 12, 21, 112]) assert.equal(en(n), "other", String(n));
});

function scheduler(overrides = {}) {
  const clock = fakeTimers();
  const runs = [];
  const state = { visible: true, hasSource: true };
  const s = createProcessScheduler({
    process: () => {
      const d = deferred();
      runs.push(d);
      return d.promise;
    },
    canRun: () => state.visible,
    canSchedule: () => state.visible && state.hasSource,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  });
  return { s, clock, runs, state };
}

test("scheduling is debounced by 100 ms", async () => {
  const { s, clock, runs } = scheduler();
  s.schedule();
  clock.advance(60);
  s.schedule();
  clock.advance(60);
  assert.equal(runs.length, 0, "the second call restarts the wait");
  clock.advance(40);
  assert.equal(runs.length, 1);
  runs[0].resolve();
  await tick();
  assert.equal(runs.length, 1);
});

test("nothing is scheduled without a photo", () => {
  const { s, clock, state } = scheduler();
  state.hasSource = false;
  s.schedule();
  assert.equal(clock.count, 0);
  state.hasSource = true;
  state.visible = false;
  s.schedule();
  assert.equal(clock.count, 0);
});

test("calls while processing are coalesced into one more run", async () => {
  const { s, clock, runs } = scheduler();
  s.schedule();
  clock.advance(100);
  assert.equal(runs.length, 1);
  for (let i = 0; i < 3; i++) {
    s.schedule();
    clock.advance(100);
  }
  assert.equal(runs.length, 1, "the first run is still going");
  runs[0].resolve();
  await tick();
  assert.equal(runs.length, 2, "one run for the three calls");
  runs[1].resolve();
  await tick();
  assert.equal(runs.length, 2);
});

test("a failed run still lets the coalesced one start", async () => {
  const { s, runs } = scheduler();
  const first = s.run().catch((e) => e.message);
  s.run();
  assert.equal(runs.length, 1);
  runs[0].reject(new Error("boom"));
  assert.equal(await first, "boom");
  assert.equal(runs.length, 2);
});

test("cancel drops the waiting and the coalesced call", async () => {
  const { s, clock, runs } = scheduler();
  s.schedule();
  s.cancel();
  clock.advance(200);
  assert.equal(runs.length, 0);

  s.schedule();
  clock.advance(100);
  s.schedule();
  clock.advance(100);
  s.cancel();
  runs[0].resolve();
  await tick();
  assert.equal(runs.length, 1);
});

test("a run does not start once the preview is gone", async () => {
  const { s, clock, runs, state } = scheduler();
  s.schedule();
  state.visible = false;
  clock.advance(100);
  assert.equal(runs.length, 0);
});

function saver() {
  const log = [];
  const gates = [];
  const queue = createHistorySaveQueue();
  // A save that waits for gates[i] to be opened.
  const save = (name, options) => {
    const gate = deferred();
    gates.push(gate);
    return queue.enqueue({
      task: async () => {
        log.push(`start ${name}`);
        await gate.promise;
        log.push(`end ${name}`);
      },
      ...options,
    });
  };
  return { queue, log, gates, save };
}

test("saves run one after another, in order", async () => {
  const { queue, log, gates, save } = saver();
  save("a", { session: 1, key: "1" });
  save("b", { session: 1, key: "2" });
  save("c", { session: 1, key: "3" });
  await tick();
  assert.deepEqual(log, ["start a"]);
  gates[2].resolve();
  gates[0].resolve();
  await tick();
  assert.deepEqual(log, ["start a", "end a", "start b"]);
  gates[1].resolve();
  await queue.flush();
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});

test("a save that changes nothing is skipped", async () => {
  const { queue, log, gates, save } = saver();
  assert.equal(save("a", { session: 1, key: "k" }), true);
  assert.equal(save("same", { session: 1, key: "k" }), false);
  assert.equal(save("forced", { session: 1, key: "k", force: true }), true);
  assert.equal(save("other", { session: 1, key: "k2" }), true);
  gates.forEach((g) => g.resolve());
  await queue.flush();
  assert.deepEqual(
    log.filter((l) => l.startsWith("start")),
    ["start a", "start forced", "start other"],
  );
});

test("a new editing session is not confused with an old one", async () => {
  const { queue, save, gates } = saver();
  save("old", { session: 1, key: "k" });
  assert.equal(save("new", { session: 2, key: "k" }), true, "same key, other session");
  assert.equal(queue.savedKey(1), "k");
  assert.equal(queue.savedKey(2), "k");
  assert.equal(save("old again", { session: 1, key: "k" }), false);
  queue.markSaved(3, "opened");
  assert.equal(save("opened entry", { session: 3, key: "opened" }), false);
  assert.equal(save("edited entry", { session: 3, key: "edited" }), true);
  gates.forEach((g) => g.resolve());
  await queue.flush();
});

test("a failed save is forgotten, so the next one retries, and the chain goes on", async () => {
  const { queue, log, gates, save } = saver();
  const errors = [];
  let undone = 0;
  const failing = queue.enqueue({
    session: 1,
    key: "k",
    task: async () => {
      throw new Error("disk full");
    },
    onUndo: () => undone++,
    onError: (e) => errors.push(e.message),
  });
  assert.equal(failing, true);
  save("next", { session: 1, key: "k2" });
  gates[0].resolve();
  await queue.flush();
  assert.deepEqual(errors, ["disk full"]);
  assert.equal(undone, 1);
  assert.equal(log.includes("end next"), true);
  assert.equal(queue.savedKey(1), "k2");

  // A task that reports false (no thumbnail) is undone too.
  let undone2 = 0;
  queue.enqueue({ session: 2, key: "x", task: async () => false, onUndo: () => undone2++ });
  await queue.flush();
  assert.equal(undone2, 1);
  assert.equal(queue.savedKey(2), undefined);
  assert.equal(save("retry", { session: 2, key: "x" }), true);
  gates.forEach((g) => g.resolve());
  await queue.flush();
});

test("undoing an old save does not erase a newer key", async () => {
  const queue = createHistorySaveQueue();
  const gate = deferred();
  queue.enqueue({
    session: 1,
    key: "a",
    task: async () => {
      await gate.promise;
      return false;
    },
  });
  queue.enqueue({ session: 1, key: "b", task: async () => {} });
  gate.resolve();
  await queue.flush();
  assert.equal(queue.savedKey(1), "b");
});
