/**
 * Test: does GHC SDK resumeSession restore conversation turns across process restarts?
 * 
 * 1. Create session, send message, get reply, stop client
 * 2. Create NEW client, resumeSession with same ID
 * 3. Send follow-up — does model remember first message?
 */
import { CopilotClient } from '@github/copilot-sdk';

const COPILOT_HOME = '/tmp/test-resume-turns';

async function waitIdle(session: any): Promise<void> {
  return new Promise((resolve) => {
    const unsub = session.on('session.idle' as any, () => { unsub(); resolve(); });
  });
}

async function getReply(session: any): Promise<string> {
  let reply = '';
  const unsub = session.on('assistant.message' as any, (e: any) => {
    if (e.data?.content) reply = e.data.content;
  });
  const idle = waitIdle(session);
  await idle;
  unsub();
  return reply;
}

async function test() {
  const token = process.env.COPILOT_GITHUB_TOKEN;
  if (!token) { console.error('Set COPILOT_GITHUB_TOKEN'); process.exit(1); }

  const fs = await import('fs');
  fs.mkdirSync(COPILOT_HOME, { recursive: true });

  const sessionId = `test-resume-${Date.now()}`;

  // === PHASE 1: Create session, send message, stop ===
  console.log('=== PHASE 1: Create + send + stop ===');
  const client1 = new CopilotClient({ token });
  const session1 = await client1.createSession({
    model: 'gpt-4o-mini',
    sessionId,
    configDir: COPILOT_HOME,
    onPermissionRequest: async () => true,
  });
  console.log(`Session created: ${session1.sessionId}`);

  const idle1 = waitIdle(session1);
  let reply1 = '';
  const unsub1 = session1.on('assistant.message' as any, (e: any) => {
    if (e.data?.content) reply1 = e.data.content;
  });
  await session1.send({ prompt: 'Remember this: the magic word is FOXTROT-8832. Confirm.' });
  await idle1;
  unsub1();
  console.log(`Reply 1: ${reply1.substring(0, 100)}`);

  console.log('Stopping client 1...');
  await client1.stop();
  console.log('Client 1 stopped.\n');

  // Wait a moment
  await new Promise(r => setTimeout(r, 3000));

  // === PHASE 2: New client, resume session, ask follow-up ===
  console.log('=== PHASE 2: New client + resume + ask ===');
  const client2 = new CopilotClient({ token });
  let session2: any;
  try {
    session2 = await client2.resumeSession(sessionId, {
      model: 'gpt-4o-mini',
      configDir: COPILOT_HOME,
      onPermissionRequest: async () => true,
    });
    console.log(`Session resumed: ${session2.sessionId}`);
  } catch (err: any) {
    console.log(`Resume failed: ${err.message}`);
    console.log('Creating new session instead...');
    session2 = await client2.createSession({
      model: 'gpt-4o-mini',
      sessionId: sessionId + '-retry',
      configDir: COPILOT_HOME,
      onPermissionRequest: async () => true,
    });
  }

  const idle2 = waitIdle(session2);
  let reply2 = '';
  const unsub2 = session2.on('assistant.message' as any, (e: any) => {
    if (e.data?.content) reply2 = e.data.content;
  });
  await session2.send({ prompt: 'What was the magic word I told you?' });
  await idle2;
  unsub2();
  console.log(`Reply 2: ${reply2.substring(0, 200)}`);

  const remembered = reply2.includes('FOXTROT-8832');
  console.log(`\n=== RESULT: resumeSession restores turns: ${remembered ? 'YES ✅' : 'NO ❌'} ===`);

  await client2.stop();
  
  // Cleanup
  fs.rmSync(COPILOT_HOME, { recursive: true, force: true });
  
  process.exit(remembered ? 0 : 1);
}

test().catch(err => { console.error('Error:', err); process.exit(1); });
