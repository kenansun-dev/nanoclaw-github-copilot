#!/usr/bin/env node
/**
 * spike-teams-streaming.mjs — Phase B protocol verification spike.
 *
 * Verifies the three open questions that block proposal
 * `docs/proposals/2026-05-21-teams-thinking-phase-B.md`:
 *
 *   Q1 (case b in matrix): Does the Teams server accept a `final`
 *      `message` activity that ENDS a stream with empty/whitespace
 *      text? Needed for cancel-during-thinking orphan dismiss.
 *
 *   Q3 (size limits): Where exactly does the server reject an
 *      `informative` payload? MS docs say 1 KB / 1000 chars; we want
 *      a real-server confirmation.
 *
 *   FINDING 1 (HARD BLOCKER): "each subsequent bot message chunk must
 *      include all previously streamed content." Does the server
 *      reject a `streaming` chunk whose `text` is shorter than (or
 *      not a prefix of) the previous chunk? If yes, `commitAnswer()`
 *      cannot reset `_latestText` and phase B's core mechanism is
 *      DEAD — fallback to either (i) thinking-prefix + answer
 *      concatenation, or (ii) two serial streaming sessions.
 *
 *   FINDING 3: Is streaming actually rejected in group/channel
 *      conversations? Docs say "1:1 chats only" — confirm on a real
 *      server response.
 *
 * NO SDK DEPENDENCY. Plain Bot Framework REST. Run with:
 *
 *   MICROSOFT_APP_ID=... \
 *   MICROSOFT_APP_PASSWORD=... \
 *   TEAMS_SERVICE_URL=https://smba.trafficmanager.net/amer/ \
 *   TEAMS_CONV_ID_1_1=a:... \
 *   TEAMS_CONV_ID_GROUP=19:...@thread.tacv2 \
 *   node scripts/spike-teams-streaming.mjs
 *
 * Owner ALSO needs to eyeball the Teams client during/after each case
 * (Windows + Web ideally) and paste observations + this script's
 * JSON output into the PR.
 */

const APP_ID = process.env.MICROSOFT_APP_ID;
const APP_PWD = process.env.MICROSOFT_APP_PASSWORD;
const SERVICE_URL = process.env.TEAMS_SERVICE_URL;
const CONV_1_1 = process.env.TEAMS_CONV_ID_1_1;
const CONV_GROUP = process.env.TEAMS_CONV_ID_GROUP;

function need(name, val) {
  if (!val) {
    console.error(`Missing env: ${name}`);
    process.exit(2);
  }
  return val;
}
need('MICROSOFT_APP_ID', APP_ID);
need('MICROSOFT_APP_PASSWORD', APP_PWD);
need('TEAMS_SERVICE_URL', SERVICE_URL);
need('TEAMS_CONV_ID_1_1', CONV_1_1);
// CONV_GROUP optional — case 4 skipped if absent.

async function getToken() {
  const url = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: APP_ID,
    client_secret: APP_PWD,
    scope: 'https://api.botframework.com/.default',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Auth failed ${res.status}: ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

async function postActivity(token, convId, activity) {
  const url = `${SERVICE_URL.replace(/\/$/, '')}/v3/conversations/${encodeURIComponent(convId)}/activities`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(activity),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, body: json };
}

function mkActivity({ type, text, streamType, sequence, streamId }) {
  const act = {
    type,
    text,
    entities: [
      {
        type: 'streaminfo',
        streamType,
        streamSequence: sequence,
        ...(streamId ? { streamId } : {}),
      },
    ],
    ...(streamId ? { id: streamId } : {}),
  };
  return act;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const results = [];

async function record(name, fn) {
  const start = Date.now();
  try {
    const out = await fn();
    results.push({ case: name, ok: true, durationMs: Date.now() - start, ...out });
    console.log(`✓ ${name}`, JSON.stringify(out, null, 2));
  } catch (err) {
    results.push({ case: name, ok: false, durationMs: Date.now() - start, error: String(err) });
    console.log(`✗ ${name}: ${err}`);
  }
}

// -------- Spike cases --------

async function case1_shortChunk(token) {
  // FINDING 1: bootstrap informative with long thinking, then send a
  // streaming chunk whose text is SHORTER than the informative.
  // If server rejects, phase B core mechanism is dead.
  const longThinking = 'Thinking about your question. '.repeat(8); // ~240 chars
  const boot = await postActivity(
    token,
    CONV_1_1,
    mkActivity({ type: 'typing', text: longThinking, streamType: 'informative', sequence: 1 }),
  );
  const streamId = boot.body?.id;
  await sleep(1100); // honor Teams chunk delay
  const shortAnswer = await postActivity(
    token,
    CONV_1_1,
    mkActivity({
      type: 'typing',
      text: 'A.', // intentionally shorter, not a prefix of thinking
      streamType: 'streaming',
      sequence: 2,
      streamId,
    }),
  );
  await sleep(1100);
  const final = await postActivity(
    token,
    CONV_1_1,
    mkActivity({ type: 'message', text: 'A.', streamType: 'final', sequence: 3, streamId }),
  );
  return { boot, shortAnswer, final };
}

async function case2_dismissEmpty(token) {
  // Q1: bootstrap + final with empty/whitespace to confirm dismiss path.
  const boot = await postActivity(
    token,
    CONV_1_1,
    mkActivity({ type: 'typing', text: 'Thinking…', streamType: 'informative', sequence: 1 }),
  );
  const streamId = boot.body?.id;
  await sleep(1100);
  const final = await postActivity(
    token,
    CONV_1_1,
    mkActivity({ type: 'message', text: ' ', streamType: 'final', sequence: 2, streamId }),
  );
  return { boot, final };
}

async function case3_informativeSize(token) {
  // Q3: how big can informative payload get before reject?
  const tries = [];
  for (const size of [500, 1000, 1024, 1500, 4000]) {
    const text = 'x'.repeat(size);
    const res = await postActivity(
      token,
      CONV_1_1,
      mkActivity({ type: 'typing', text, streamType: 'informative', sequence: 1 }),
    );
    tries.push({ size, status: res.status, ok: res.ok, bodyExcerpt: JSON.stringify(res.body).slice(0, 240) });
    if (res.ok && res.body?.id) {
      // end the stream so we don't leak.
      await postActivity(
        token,
        CONV_1_1,
        mkActivity({ type: 'message', text: ' ', streamType: 'final', sequence: 2, streamId: res.body.id }),
      );
    }
    await sleep(800);
  }
  return { tries };
}

async function case4_groupChannel(token) {
  if (!CONV_GROUP) return { skipped: 'TEAMS_CONV_ID_GROUP not set' };
  // FINDING 3: does group/channel actually reject streaming?
  const boot = await postActivity(
    token,
    CONV_GROUP,
    mkActivity({ type: 'typing', text: 'Thinking…', streamType: 'informative', sequence: 1 }),
  );
  return { boot };
}

(async () => {
  console.log('Phase B Teams streaming spike — fetching token…');
  const token = await getToken();
  console.log('Token OK. service_url=', SERVICE_URL);

  await record('case1_shortChunk (FINDING 1: short streaming chunk)', () => case1_shortChunk(token));
  await record('case2_dismissEmpty (Q1: final-with-whitespace dismiss)', () => case2_dismissEmpty(token));
  await record('case3_informativeSize (Q3: informative size limit)', () => case3_informativeSize(token));
  await record('case4_groupChannel (FINDING 3: group rejects streaming)', () => case4_groupChannel(token));

  console.log('\n===== SPIKE RESULTS =====');
  console.log(JSON.stringify(results, null, 2));
  console.log('\nPlease ALSO paste Teams client (Windows + Web) observations into the PR:');
  console.log('  • case1: did the bubble briefly show "Thinking about..." and then change to "A." cleanly, or did it duplicate / leave the thinking text?');
  console.log('  • case2: did the "Thinking…" bubble disappear or leave a blank message?');
  console.log('  • case3: any client-side render glitches at large sizes?');
  console.log('  • case4: did anything appear in the group at all?');
})().catch((err) => {
  console.error('Spike failed:', err);
  process.exit(1);
});
