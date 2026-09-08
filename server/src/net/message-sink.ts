export interface MessageSink {
  broadcast(type: string, payload: unknown): void;
  sendTo(playerId: string, type: string, payload: unknown): void;
}

export const NULL_SINK: MessageSink = {
  broadcast(): void {},
  sendTo(): void {},
};
