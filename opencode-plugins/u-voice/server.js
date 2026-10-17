import { VOICE_RPC, VOICE_SYSTEM_SECTION, voiceBlock } from './voice-state.js';

// Server side of U-voice. Audio, captions and delegation live in the TUI
// entrypoint; this side owns what must happen inside the session:
// - one constant system section, present whether or not voice is on, so
//   toggling voice never rewrites the system prompt;
// - speech not yet delivered rides along with the next typed prompt.
export default {
  id: 'uvoice',
  async setup(ctx) {
    const pending = new Map();
    await ctx.rpc.register(VOICE_RPC, {
      pending: async input => {
        if (typeof input?.sessionID !== 'string') return {};
        if (typeof input.text === 'string' && input.text.trim()) pending.set(input.sessionID, { text: input.text, through: input.through });
        else pending.delete(input.sessionID);
        return {};
      },
    });
    await ctx.session.hook('context', event => {
      event.system.push({ type: 'text', text: VOICE_SYSTEM_SECTION });
    });
    await ctx.session.hook('prompt', event => {
      if (event.metadata?.uvoice) return;
      const held = pending.get(event.sessionID);
      if (!held) return;
      pending.delete(event.sessionID);
      event.prompt.text = voiceBlock('typed', held.text) + '\n\n' + event.prompt.text;
      // The TUI marks this speech delivered once it sees the prompt enqueued.
      event.metadata = { ...(event.metadata ?? {}), uvoiceTyped: held.through };
    });
  },
};
