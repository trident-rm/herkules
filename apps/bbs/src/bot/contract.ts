export interface IncomingMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: "p2p" | "group";
  readonly content: string;
  readonly rawContentType: string;
  readonly mentionedBot: boolean;
  readonly createTime: number;
}

/** A button press on a card the bot sent (`card.action.trigger`). */
export interface IncomingCardAction {
  /** The card's own message id; the reply is an in-place update of this card. */
  readonly messageId: string;
  readonly chatId: string;
  readonly operatorOpenId: string;
  /** The button's `value`, exactly as the card carried it. Validated by `parseAction`. */
  readonly value: unknown;
}

/** A click on the bot menu next to the input box (`application.bot.menu_v6`). */
export interface IncomingMenuClick {
  readonly operatorOpenId: string;
  readonly eventKey: string;
  readonly timestamp: number;
}

export type Inbound =
  | { readonly kind: "message"; readonly message: IncomingMessage }
  | { readonly kind: "action"; readonly action: IncomingCardAction }
  | { readonly kind: "menu"; readonly menu: IncomingMenuClick };

export interface OutboundEnvelope {
  readonly id: string;
  /** `update` patches the card at `replyToMessageId` instead of sending a new message. */
  readonly kind: "article" | "digest" | "reply" | "update" | "resources";
  /** A chat id (`oc_…`) or, for menu-triggered replies, a user open id (`ou_…`). */
  readonly chatId: string;
  readonly replyToMessageId: string | null;
  readonly msgType: string;
  readonly content: string;
  readonly uuid: string;
  readonly leaseToken: string;
  readonly attemptNo: number;
}

export type SendOutcome =
  | { readonly kind: "sent"; readonly messageId: string }
  | {
      readonly kind: "not_sent" | "ambiguous";
      readonly code: string;
      readonly retryAfterMs?: number;
    }
  | { readonly kind: "permanent"; readonly code: string; readonly fatal: boolean };

export interface BotTransport {
  connect(onInbound: (inbound: Inbound) => Promise<void>): Promise<void>;
  send(envelope: OutboundEnvelope, signal: AbortSignal): Promise<SendOutcome>;
  disconnect(): Promise<void>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
};
