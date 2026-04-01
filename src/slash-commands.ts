/**
 * Unified slash command registry.
 *
 * Define commands once here — each channel adapter reads this list
 * and registers natively (Telegram setMyCommands, Teams Adaptive Card, etc.).
 *
 * Command execution stays in index.ts (text-based interception).
 * This file only defines metadata for platform menus/cards.
 *
 * NON-INVASIVE: no upstream channel files are modified.
 */

export interface SlashCommand {
  /** Command name without leading / */
  name: string;
  /** Short description for menus */
  description: string;
  /** Argument placeholder (shown in help) */
  args?: string;
  /** Valid choices for the argument (used by Adaptive Card dropdowns) */
  choices?: { title: string; value: string }[];
  /** If true, command takes no arguments and executes immediately */
  noArgs?: boolean;
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'think',
    description: 'Set reasoning effort level',
    args: 'off|low|medium|high|xhigh',
    choices: [
      { title: 'Off (default)', value: 'off' },
      { title: 'Low', value: 'low' },
      { title: 'Medium', value: 'medium' },
      { title: 'High', value: 'high' },
      { title: 'Extra High', value: 'xhigh' },
    ],
  },
  {
    name: 'new',
    description: 'Reset session — start fresh conversation',
    noArgs: true,
  },
  {
    name: 'help',
    description: 'Show available commands',
    noArgs: true,
  },
];

// ─── Telegram: register bot menu commands ────────────────────────────────────

/**
 * Register commands with Telegram Bot API (setMyCommands).
 * Call once after bot connects. Non-invasive — uses HTTP API directly.
 */
export async function registerTelegramCommands(
  botToken: string,
): Promise<void> {
  const commands = COMMANDS.map((c) => ({
    command: c.name,
    description: c.description + (c.args ? ` (${c.args})` : ''),
  }));

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/setMyCommands`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands }),
      },
    );
    const data = (await resp.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error(
        `[slash-commands] Telegram setMyCommands failed: ${data.description}`,
      );
    }
  } catch (err) {
    console.error(`[slash-commands] Telegram setMyCommands error: ${err}`);
  }
}

// ─── Teams: Adaptive Card for command selection ──────────────────────────────

/**
 * Build a Teams Adaptive Card JSON for a command with choices.
 * When user sends /think (no args), we reply with this card.
 */
export function buildTeamsAdaptiveCard(
  command: SlashCommand,
  currentValue?: string,
): object {
  if (!command.choices) {
    return {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: `/${command.name}: ${command.description}`,
          weight: 'bolder',
          size: 'medium',
        },
      ],
    };
  }

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: command.description,
        weight: 'bolder',
        size: 'medium',
      },
      ...(currentValue
        ? [
            {
              type: 'TextBlock',
              text: `Current: **${currentValue}**`,
              spacing: 'small',
            },
          ]
        : []),
      {
        type: 'Input.ChoiceSet',
        id: `${command.name}_value`,
        label: `Select ${command.name} level:`,
        style: 'compact',
        value: currentValue || command.choices[0]?.value || '',
        choices: command.choices.map((c) => ({
          title: c.title,
          value: c.value,
        })),
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: 'Apply',
        data: { command: command.name },
      },
    ],
  };
}

/**
 * Parse a Teams Adaptive Card submit action.
 * Returns the slash command text (e.g., "/think high") or null if not a card submit.
 */
export function parseTeamsCardSubmit(activity: any): string | null {
  if (activity.type !== 'message') return null;

  // Adaptive Card submissions come as activity.value (no activity.text)
  const value = activity.value;
  if (!value || typeof value !== 'object') return null;

  const command = value.command;
  if (!command) return null;

  // Find the command definition
  const cmd = COMMANDS.find((c) => c.name === command);
  if (!cmd) return null;

  // Extract the selected value
  const selectedValue = value[`${command}_value`];
  if (selectedValue) {
    return `/${command} ${selectedValue}`;
  }

  return `/${command}`;
}

// ─── Help text generator ─────────────────────────────────────────────────────

export function buildHelpText(): string {
  const lines = ['**Available commands:**', ''];
  for (const cmd of COMMANDS) {
    const argStr = cmd.args ? ` <${cmd.args}>` : '';
    lines.push(`  \`/${cmd.name}${argStr}\` — ${cmd.description}`);
  }
  return lines.join('\n');
}
