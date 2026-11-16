/** Milliseconds since the epoch, by a key: a transcript row's id, or a text key. */
export type MessageTimes = { [key: string]: number }

declare module 'claude-code' {
  interface PluginState {
    'message-times': {
      /** Stamped rows by row id: the user's prompts and each turn's final reply. */
      byId: MessageTimes
      /** The same stamps by a key of the row's text, for a row whose id differs. */
      byText: MessageTimes
    }
  }
}
