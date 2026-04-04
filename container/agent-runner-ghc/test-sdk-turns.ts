/**
 * Minimal test: does GHC SDK session.send() maintain conversation turns?
 * 
 * Directly calls the SDK without nanoclaw's agent-runner.
 * Tests if a second send() on the same session has context from the first.
 */
import { CopilotClient } from '@github/copilot-sdk';

async function test() {
  const token = process.env.COPILOT_GITHUB_TOKEN;
  if (!token) {
    console.error('Set COPILOT_GITHUB_TOKEN');
    process.exit(1);
  }

  console.log('Creating client...');
  const client = new CopilotClient({ token });

  console.log('Creating session...');
  const session = await client.createSession({
    model: 'gpt-4o-mini',
    sessionId: `test-turns-${Date.now()}`,
    onPermissionRequest: async () => true,
  });

  console.log(`Session: ${session.sessionId}`);

  // First send
  console.log('\n--- SEND 1: Tell it a code ---');
  const idle1 = new Promise<void>((resolve) => {
    const unsub = session.on('session.idle' as any, () => {
      unsub();
      resolve();
    });
  });

  let reply1 = '';
  const unsub1 = session.on('assistant.message' as any, (event: any) => {
    reply1 = event.data?.content || '';
  });

  await session.send({ prompt: 'Remember this code: DELTA-5577. Just confirm.' });
  await idle1;
  unsub1();
  console.log('Reply 1:', reply1.substring(0, 200));

  // Second send — does it remember?
  console.log('\n--- SEND 2: Ask for the code ---');
  const idle2 = new Promise<void>((resolve) => {
    const unsub = session.on('session.idle' as any, () => {
      unsub();
      resolve();
    });
  });

  let reply2 = '';
  const unsub2 = session.on('assistant.message' as any, (event: any) => {
    reply2 = event.data?.content || '';
  });

  await session.send({ prompt: 'What was the code I told you?' });
  await idle2;
  unsub2();
  console.log('Reply 2:', reply2.substring(0, 200));

  const hasTurns = reply2.includes('DELTA-5577');
  console.log(`\n=== RESULT: SDK maintains turns: ${hasTurns ? 'YES ✅' : 'NO ❌'} ===`);

  await client.stop();
  process.exit(hasTurns ? 0 : 1);
}

test().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
