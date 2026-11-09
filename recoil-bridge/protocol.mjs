export const MAX_FRAME_SIZE = 64 * 1024;
const MAX_REMEMBERED = 50000;

export function encodeFrame(envelope) {
  const body = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (body.length === 0 || body.length > MAX_FRAME_SIZE) throw new Error('message exceeds pipe frame limit');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
}

function integer(value, min = 0) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= min ? result : null;
}

// State is scoped to the bridge process and survives reconnects.
export class MessageConverter {
  constructor({ fenPerDiamond = 10, onWarning = () => {} } = {}) {
    if (!Number.isSafeInteger(fenPerDiamond) || fenPerDiamond < 0) throw new Error('invalid fenPerDiamond');
    this.fenPerDiamond = fenPerDiamond;
    this.onWarning = onWarning;
    this.groups = new Map();
    this.messages = new Map();
  }

  convert(message, roomId, now = Date.now()) {
    if (!message || typeof message !== 'object') return null;
    const method = message.method;
    if (method === 'WebcastControlMessage') {
      if (message.room?.status !== 3) return null;
      return { protocolVersion: 1, eventType: 'live_end', roomId, occurredAtMs: now, payload: {} };
    }
    if (typeof message.user?.id !== 'string' || !message.user.id.trim()) {
      if (['WebcastChatMessage', 'WebcastGiftMessage', 'WebcastLikeMessage', 'WebcastMemberMessage', 'WebcastSocialMessage'].includes(method))
        this.onWarning('事件缺少稳定用户 ID', method);
      return null;
    }
    const payload = {
      userId: `douyin:${message.user.id}`,
      userName: typeof message.user.name === 'string' ? message.user.name : '',
      avatarUrl: typeof message.user.avatar === 'string' ? message.user.avatar : '',
    };
    let eventType;
    switch (method) {
      case 'WebcastChatMessage':
        if (typeof message.content !== 'string' || !message.content.trim()) return null;
        eventType = 'comment';
        payload.commentText = message.content;
        break;
      case 'WebcastMemberMessage':
        eventType = 'interact';
        payload.interactType = 1;
        break;
      case 'WebcastLikeMessage':
        eventType = 'interact';
        payload.interactType = 6;
        break;
      case 'WebcastSocialMessage': {
        const action = integer(message.socialAction);
        if (action !== 1 && action !== 3) {
          this.onWarning('未知社交 action，未转发', message.socialAction);
          return null;
        }
        eventType = 'interact';
        payload.interactType = action === 1 ? 2 : 3;
        break;
      }
      case 'WebcastGiftMessage': {
        const gift = message.gift;
        const count = integer(gift?.count, 1);
        const diamonds = integer(gift?.price);
        if (typeof gift?.name !== 'string' || !gift.name.trim() || count === null || diamonds === null || !Number.isSafeInteger(diamonds * this.fenPerDiamond)) {
          this.onWarning('礼物字段不完整或数值无效，未转发', message.id);
          return null;
        }
        const groupId = String(gift.groupId || '');
        if (!groupId || groupId === '0') {
          if (count !== 1 || !message.id) {
            this.onWarning('礼物缺少连击组 ID，无法确认数量，未转发', message.id);
            return null;
          }
        } else {
          const key = JSON.stringify([roomId, payload.userId, gift.id || gift.name, groupId]);
          const previous = this.groups.get(key) || 0;
          if (count <= previous) return null;
          remember(this.groups, key, count);
          payload.giftCount = count - previous;
        }
        payload.giftName = gift.name;
        payload.giftCount ??= count;
        payload.price = diamonds * this.fenPerDiamond;
        eventType = 'gift_send';
        break;
      }
      default:
        return null;
    }
    // Combo updates can reuse the message ID; deduplicate by group and count.
    if (message.id && !(eventType === 'gift_send' && message.gift?.groupId && message.gift.groupId !== '0')) {
      const key = JSON.stringify([roomId, method, String(message.id)]);
      if (this.messages.has(key)) return null;
      remember(this.messages, key, true);
    }
    const timestamp = integer(message.timestamp);
    return { protocolVersion: 1, eventType, roomId, occurredAtMs: timestamp ?? now, payload };
  }
}

export function convertMessage(message, roomId, now = Date.now()) {
  return new MessageConverter().convert(message, roomId, now);
}
