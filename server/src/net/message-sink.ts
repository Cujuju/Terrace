// The seam between the World and the network.
//
// The World must stay independent of Colyseus (design §3.2: "the server is
// structured around a single `World` object so a rooms layer could be added
// later without rework"). It therefore talks to this interface, never to a
// Room. The Colyseus room installs a real sink on create; tests install a
// recording sink; an un-networked World keeps NULL_SINK and simply drops
// outgoing traffic.

export interface MessageSink {
  /** Send to every connected client. */
  broadcast(type: string, payload: unknown): void;
  /** Send to one player; unknown player ids are silently ignored (they may have just left). */
  sendTo(playerId: string, type: string, payload: unknown): void;
}

/** Sink for a World with no room attached (boot, snapshots restore, tests). */
export const NULL_SINK: MessageSink = {
  broadcast(): void {},
  sendTo(): void {},
};
