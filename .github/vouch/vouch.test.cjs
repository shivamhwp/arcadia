const test = require("node:test");
const assert = require("node:assert/strict");
const vouch = require("./vouch.cjs");

const FILES = {
  list: [
    "# maintainers vouch below",
    "",
    "Alice",
    "github:Bob",
    "-mallory spam and abuse",
    "-github:Eve",
    "  carol  ",
    "gitlab:dave",
  ].join("\n"),
  unvouchedNote: "Hi @{author}, see {owner}/{repo} on {default_branch}.",
  denouncedNote: "Closed for @{author}.",
};

const WRITE_METHODS = new Set([
  "issues.addLabels",
  "issues.removeLabel",
  "issues.createLabel",
  "issues.createComment",
  "issues.update",
  "pulls.update",
  "actions.reRunWorkflow",
]);

function pr(number, login, { labels = [], state = "open", sha = `sha${number}` } = {}) {
  return {
    number,
    state,
    user: login === null ? null : { login },
    labels: labels.map((name) => ({ name })),
    head: { sha },
  };
}

function fakeGithub({
  permissions = {},
  pulls = [],
  issues = [],
  comments = {},
  repoLabels = vouch.LABEL_SPECS.map(({ name }) => ({ name })),
  runs = {},
  jobs = {},
} = {}) {
  const calls = [];
  const record = (name, handler) => async (params) => {
    calls.push({ name, params });
    return handler(params || {});
  };
  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
  const rest = {
    repos: {
      getCollaboratorPermissionLevel: record("repos.getCollaboratorPermissionLevel", ({ username }) => {
        const permission = permissions[username];
        if (!permission) throw notFound();
        return { data: { permission } };
      }),
    },
    pulls: {
      list: record("pulls.list", () => ({ data: pulls })),
      get: record("pulls.get", ({ pull_number }) => ({ data: pulls.find((item) => item.number === pull_number) })),
      update: record("pulls.update", () => ({ data: {} })),
    },
    issues: {
      listLabelsForRepo: record("issues.listLabelsForRepo", () => ({ data: repoLabels })),
      createLabel: record("issues.createLabel", () => ({ data: {} })),
      addLabels: record("issues.addLabels", () => ({ data: [] })),
      removeLabel: record("issues.removeLabel", () => ({ data: [] })),
      listComments: record("issues.listComments", ({ issue_number }) => ({ data: comments[issue_number] || [] })),
      createComment: record("issues.createComment", () => ({ data: {} })),
      update: record("issues.update", () => ({ data: {} })),
      listForRepo: record("issues.listForRepo", ({ creator }) => ({
        data: issues.filter((issue) => issue.user && issue.user.login === creator && issue.state === "open"),
      })),
    },
    actions: {
      listWorkflowRuns: record("actions.listWorkflowRuns", ({ head_sha }) => ({
        data: { workflow_runs: runs[head_sha] || [] },
      })),
      listJobsForWorkflowRun: record("actions.listJobsForWorkflowRun", ({ run_id }) => ({ data: jobs[run_id] || [] })),
      reRunWorkflow: record("actions.reRunWorkflow", () => ({ data: {} })),
    },
  };
  const paginate = async (method, params) => (await method(params)).data;
  const writes = () => calls.filter((call) => WRITE_METHODS.has(call.name));
  const named = (name) => calls.filter((call) => call.name === name);
  return { rest, paginate, calls, writes, named };
}

function fakeCore() {
  const outputs = {};
  const summaries = [];
  const summary = {
    text: "",
    addRaw(text) {
      this.text += text;
      return this;
    },
    async write() {
      summaries.push(this.text);
      this.text = "";
      return this;
    },
  };
  return { outputs, summaries, summary, info() {}, warning() {}, setOutput: (key, value) => (outputs[key] = value) };
}

function context(eventName, payload = {}) {
  return {
    eventName,
    repo: { owner: "acme", repo: "ardia" },
    payload: { repository: { default_branch: "main" }, ...payload },
  };
}

async function invoke(entry, { github, eventName, payload, env = {} }) {
  const core = fakeCore();
  const result = await vouch[entry]({ github, context: context(eventName, payload), core, files: FILES, env, pace: async () => {} });
  return { core, result };
}

test("the list parser handles plain names, the github prefix, denounced reasons, comments, blanks and case", () => {
  const list = vouch.parseVouchedList(FILES.list);
  assert.deepEqual([...list.keys()].sort(), ["alice", "bob", "carol", "eve", "mallory"]);
  assert.deepEqual(list.get("mallory"), { denounced: true, reason: "spam and abuse" });
  assert.deepEqual(list.get("eve"), { denounced: true, reason: null });
  assert.deepEqual(list.get("alice"), { denounced: false, reason: null });
  assert.equal(vouch.listStatus(list, "ALICE"), "vouched");
  assert.equal(vouch.listStatus(list, "dave"), "unknown");
});

test("status order: bot, then collaborator, then the list, then unknown", () => {
  const list = vouch.parseVouchedList(FILES.list);
  assert.equal(vouch.authorStatus({ list, login: "mallory[bot]", permission: "none" }), "bot");
  assert.equal(vouch.authorStatus({ list, login: "mallory", permission: "admin" }), "collaborator");
  assert.equal(vouch.authorStatus({ list, login: "mallory", permission: "write" }), "collaborator");
  assert.equal(vouch.authorStatus({ list, login: "Mallory", permission: "read" }), "denounced");
  assert.equal(vouch.authorStatus({ list, login: "alice", permission: "none" }), "vouched");
  assert.equal(vouch.authorStatus({ list, login: "stranger", permission: "read" }), "unknown");
  assert.equal(vouch.authorStatus({ list, login: null }), "unknown");
  assert.equal(vouch.labelForStatus("bot"), vouch.TRUSTED);
  assert.equal(vouch.labelForStatus("collaborator"), vouch.TRUSTED);
  assert.equal(vouch.labelForStatus("vouched"), vouch.TRUSTED);
  assert.equal(vouch.labelForStatus("unknown"), vouch.UNVOUCHED);
  assert.equal(vouch.labelForStatus("denounced"), vouch.DENOUNCED);
});

test("a new unvouched pull request gets the label and one filled note, and stays open", async () => {
  const github = fakeGithub();
  await invoke("run", { github, eventName: "pull_request_target", payload: { action: "opened", pull_request: pr(5, "stranger") } });
  assert.deepEqual(github.named("issues.addLabels").map((call) => call.params.labels), [[vouch.UNVOUCHED]]);
  const notes = github.named("issues.createComment");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].params.body, "Hi @stranger, see acme/ardia on main.");
  assert.equal(github.named("pulls.update").length, 0);
});

test("the note is not posted twice when the same opened event runs again", async () => {
  const github = fakeGithub({ comments: { 5: [{ body: "Hi @stranger, see acme/ardia on main." }] } });
  await invoke("run", { github, eventName: "pull_request_target", payload: { action: "opened", pull_request: pr(5, "stranger") } });
  assert.equal(github.named("issues.createComment").length, 0);
});

test("reopen and /recheck label an unvouched pull request but post no note", async () => {
  const reopened = fakeGithub();
  await invoke("run", { github: reopened, eventName: "pull_request_target", payload: { action: "reopened", pull_request: pr(6, "stranger") } });
  const recheck = fakeGithub();
  await invoke("run", {
    github: recheck,
    eventName: "issue_comment",
    payload: { action: "created", comment: { body: " /recheck " }, issue: { ...pr(6, "stranger"), pull_request: {} } },
  });
  for (const github of [reopened, recheck]) {
    assert.deepEqual(github.named("issues.addLabels").map((call) => call.params.labels), [[vouch.UNVOUCHED]]);
    assert.equal(github.named("issues.createComment").length, 0);
  }
});

test("a deleted account's pull request is unvouched", async () => {
  const github = fakeGithub();
  await invoke("run", { github, eventName: "pull_request_target", payload: { action: "reopened", pull_request: pr(7, null) } });
  assert.deepEqual(github.named("issues.addLabels").map((call) => call.params.labels), [[vouch.UNVOUCHED]]);
  assert.equal(github.named("repos.getCollaboratorPermissionLevel").length, 0);
});

test("a denounced author's pull request is labelled, gets the line and is closed", async () => {
  const github = fakeGithub({ permissions: { mallory: "read" } });
  await invoke("run", { github, eventName: "pull_request_target", payload: { action: "opened", pull_request: pr(8, "mallory") } });
  assert.deepEqual(github.named("issues.addLabels").map((call) => call.params.labels), [[vouch.DENOUNCED]]);
  assert.deepEqual(github.named("issues.createComment").map((call) => call.params.body), ["Closed for @mallory."]);
  assert.deepEqual(github.named("pulls.update").map((call) => call.params), [{ owner: "acme", repo: "ardia", pull_number: 8, state: "closed" }]);
});

test("a denounced author's new issue is closed as not planned; anyone else's issue is untouched", async () => {
  const denounced = fakeGithub();
  await invoke("run", { github: denounced, eventName: "issues", payload: { action: "opened", issue: pr(9, "Eve") } });
  assert.deepEqual(denounced.named("issues.addLabels").map((call) => call.params.labels), [[vouch.DENOUNCED]]);
  assert.equal(denounced.named("issues.createComment").length, 1);
  assert.deepEqual(
    denounced.named("issues.update").map(({ params }) => [params.issue_number, params.state, params.state_reason]),
    [[9, "closed", "not_planned"]],
  );
  const normal = fakeGithub();
  await invoke("run", { github: normal, eventName: "issues", payload: { action: "opened", issue: pr(10, "stranger") } });
  assert.deepEqual(normal.calls, []);
});

test("missing vouch labels are created before the first add", async () => {
  const github = fakeGithub({ repoLabels: [{ name: "vouch:trusted" }] });
  await invoke("run", { github, eventName: "pull_request_target", payload: { action: "reopened", pull_request: pr(11, "alice") } });
  assert.deepEqual(github.named("issues.createLabel").map((call) => call.params.name), [vouch.UNVOUCHED, vouch.DENOUNCED, vouch.RUN_CI]);
});

function sweepFixture() {
  return fakeGithub({
    permissions: { owner: "admin", mallory: "read" },
    pulls: [
      pr(1, "stranger"),
      pr(2, "alice", { labels: [vouch.UNVOUCHED] }),
      pr(3, "owner", { labels: [vouch.TRUSTED, vouch.UNVOUCHED, "bug"], state: "closed" }),
      pr(4, "dependabot[bot]", { labels: [vouch.TRUSTED] }),
      pr(5, "stranger", { labels: [vouch.UNVOUCHED] }),
      pr(6, "mallory"),
      pr(7, "mallory", { state: "closed", labels: [vouch.DENOUNCED] }),
    ],
    issues: [pr(20, "mallory"), pr(21, "mallory", { state: "closed" }), pr(22, "stranger")],
  });
}

test("the sweep fixes missing, wrong and double labels, closes denounced work and never posts the note", async () => {
  const github = sweepFixture();
  const { result, core } = await invoke("run", { github, eventName: "schedule" });
  const labelWrites = github.calls
    .filter((call) => call.name === "issues.addLabels" || call.name === "issues.removeLabel")
    .map(({ name, params }) => [name, params.issue_number, params.labels ? params.labels[0] : params.name]);
  assert.deepEqual(labelWrites, [
    ["issues.addLabels", 1, vouch.UNVOUCHED],
    ["issues.addLabels", 2, vouch.TRUSTED],
    ["issues.removeLabel", 2, vouch.UNVOUCHED],
    ["issues.removeLabel", 3, vouch.UNVOUCHED],
    ["issues.addLabels", 6, vouch.DENOUNCED],
    ["issues.addLabels", 20, vouch.DENOUNCED],
  ]);
  assert.ok(github.writes().every((call) => ![4, 5, 7].includes(call.params.issue_number ?? call.params.pull_number)));
  assert.deepEqual(github.named("issues.createComment").map((call) => [call.params.issue_number, call.params.body]), [
    [6, "Closed for @mallory."],
    [20, "Closed for @mallory."],
  ]);
  assert.deepEqual(github.named("pulls.update").map((call) => call.params.pull_number), [6]);
  assert.deepEqual(github.named("issues.update").map((call) => call.params.issue_number), [20]);
  assert.deepEqual(result.counts, { [vouch.TRUSTED]: 3, [vouch.UNVOUCHED]: 2, [vouch.DENOUNCED]: 2 });
  assert.equal(core.summaries.length, 1);
  assert.match(core.summaries[0], /pull request #2: vouch:unvouched -> vouch:trusted/);
});

test("the sweep leaves correctly labelled pull requests alone", async () => {
  const github = fakeGithub({
    permissions: { owner: "admin" },
    pulls: [pr(1, "owner", { labels: [vouch.TRUSTED] }), pr(2, "stranger", { labels: [vouch.UNVOUCHED, "bug"] })],
  });
  await invoke("run", { github, eventName: "schedule" });
  assert.deepEqual(github.writes(), []);
});

test("a dry-run sweep writes nothing but reports what it would do", async () => {
  const github = sweepFixture();
  const { result, core } = await invoke("run", { github, eventName: "workflow_dispatch", payload: { inputs: { dry_run: "true" } } });
  assert.deepEqual(github.writes(), []);
  assert.equal(github.named("issues.listLabelsForRepo").length, 0);
  assert.equal(result.changes.length, 5);
  assert.deepEqual(result.closed.map((item) => item.number), [6, 20]);
  assert.match(core.summaries[0], /dry run/);
});

test("collaborator permission is looked up once per login", async () => {
  const github = fakeGithub({ pulls: [pr(1, "Stranger"), pr(2, "stranger"), pr(3, "STRANGER")] });
  await invoke("run", { github, eventName: "schedule" });
  const usernames = github.named("repos.getCollaboratorPermissionLevel").map((call) => call.params.username.toLowerCase());
  assert.deepEqual(usernames.sort(), ["eve", "mallory", "stranger"]);
});

function rerunFixture() {
  return fakeGithub({
    permissions: { owner: "admin" },
    pulls: [
      pr(1, "alice", { labels: [vouch.UNVOUCHED], sha: "a1" }),
      pr(2, "alice", { labels: [vouch.UNVOUCHED], sha: "a2", state: "closed" }),
      pr(3, "alice", { labels: [vouch.TRUSTED], sha: "a3" }),
      pr(4, "stranger", { sha: "s4" }),
      pr(5, "alice", { labels: [vouch.UNVOUCHED], sha: "a5" }),
      pr(6, "alice", { labels: [vouch.UNVOUCHED], sha: "a6" }),
    ],
    runs: {
      a1: [{ id: 101, status: "completed" }, { id: 100, status: "completed" }],
      a2: [{ id: 200, status: "completed" }],
      a3: [{ id: 300, status: "completed" }],
      s4: [{ id: 400, status: "completed" }],
      a5: [{ id: 500, status: "in_progress" }],
      a6: [{ id: 600, status: "completed" }],
    },
    jobs: {
      101: [{ conclusion: "success" }, { conclusion: "skipped" }],
      100: [{ conclusion: "skipped" }],
      200: [{ conclusion: "skipped" }],
      300: [{ conclusion: "skipped" }],
      400: [{ conclusion: "skipped" }],
      600: [{ conclusion: "success" }, { conclusion: "success" }],
    },
  });
}

test("listChanged re-runs only the newest completed skipped run of open pull requests that just became trusted", async () => {
  const github = rerunFixture();
  const { result } = await invoke("listChanged", { github, eventName: "issue_comment" });
  assert.deepEqual(github.named("actions.reRunWorkflow").map((call) => call.params.run_id), [101]);
  assert.deepEqual(result.rerun, [{ workflow: "ios.yml", runId: 101, number: 1 }]);
  const lookups = github.named("actions.listWorkflowRuns").map((call) => call.params);
  assert.ok(lookups.every((params) => params.workflow_id === "ios.yml" && params.event === "pull_request"));
  assert.deepEqual(lookups.map((params) => params.head_sha), ["a1", "a5", "a6"]);
});

test("a push of the list sweeps and re-runs like listChanged", async () => {
  const github = rerunFixture();
  await invoke("run", { github, eventName: "push" });
  assert.deepEqual(github.named("actions.reRunWorkflow").map((call) => call.params.run_id), [101]);
});

test("the run-ci label re-runs that pull request's skipped build; other labels do nothing", async () => {
  const github = fakeGithub({ runs: { s9: [{ id: 900, status: "completed" }] }, jobs: { 900: [{ conclusion: "skipped" }] } });
  await invoke("run", {
    github,
    eventName: "pull_request_target",
    payload: { action: "labeled", label: { name: "run-ci" }, pull_request: pr(9, "stranger", { sha: "s9" }) },
  });
  assert.deepEqual(github.named("actions.reRunWorkflow").map((call) => call.params.run_id), [900]);
  assert.deepEqual(github.named("issues.addLabels"), []);
  const other = fakeGithub({ runs: { s9: [{ id: 900, status: "completed" }] }, jobs: { 900: [{ conclusion: "skipped" }] } });
  await invoke("run", {
    github: other,
    eventName: "pull_request_target",
    payload: { action: "labeled", label: { name: "bug" }, pull_request: pr(9, "stranger", { sha: "s9" }) },
  });
  assert.deepEqual(other.calls, []);
});

async function gateFor({ author, labels = [], attempt = 1, actor, permissions = {} }) {
  const github = fakeGithub({ permissions, pulls: [pr(42, author, { labels })] });
  const { core, result } = await invoke("gate", {
    github,
    eventName: "pull_request",
    payload: { pull_request: pr(42, author) },
    env: { GITHUB_RUN_ATTEMPT: String(attempt), GITHUB_TRIGGERING_ACTOR: actor || author },
  });
  assert.equal(core.outputs.run, result.run ? "true" : "false");
  return { core, result };
}

test("the gate always passes on push", async () => {
  const github = fakeGithub();
  const { core } = await invoke("gate", { github, eventName: "push" });
  assert.equal(core.outputs.run, "true");
  assert.deepEqual(github.calls, []);
});

test("the gate passes trusted authors", async () => {
  for (const author of ["alice", "renovate[bot]", "owner"]) {
    const { result } = await gateFor({ author, permissions: { owner: "write" } });
    assert.equal(result.run, true, author);
  }
});

test("the gate skips an unvouched author and says how to start the build", async () => {
  const { result, core } = await gateFor({ author: "stranger" });
  assert.equal(result.run, false);
  assert.match(core.summaries[0], /run-ci/);
});

test("the gate passes an unvouched author's pull request labelled run-ci, read from the API", async () => {
  const { result } = await gateFor({ author: "stranger", labels: ["run-ci"] });
  assert.equal(result.run, true);
});

test("the gate passes a re-run started by a user with write or admin", async () => {
  for (const permission of ["write", "admin"]) {
    const { result } = await gateFor({ author: "stranger", attempt: 2, actor: "maint", permissions: { maint: permission } });
    assert.equal(result.run, true, permission);
  }
});

test("the gate skips a re-run by the unvouched author or by a user with read", async () => {
  const byAuthor = await gateFor({ author: "stranger", attempt: 2, actor: "stranger" });
  const byReader = await gateFor({ author: "stranger", attempt: 3, actor: "reader", permissions: { reader: "read" } });
  assert.equal(byAuthor.result.run, false);
  assert.equal(byReader.result.run, false);
});

test("the gate never passes a denounced author, even with run-ci or a maintainer re-run", async () => {
  const { result } = await gateFor({
    author: "mallory",
    labels: ["run-ci"],
    attempt: 2,
    actor: "maint",
    permissions: { mallory: "read", maint: "admin" },
  });
  assert.equal(result.run, false);
});
