import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertMessage, encodeFrame, MAX_FRAME_SIZE, MessageConverter } from './protocol.mjs';

test('弹幕映射并以 UTF-8 字节长度编码', () => {
  const result = convertMessage({ method: 'WebcastChatMessage', user: { id: '123', name: '观众' }, content: '加入' }, '456', 42);
  assert.deepEqual(result, { protocolVersion: 1, eventType: 'comment', roomId: '456', occurredAtMs: 42,
    payload: { userId: 'douyin:123', userName: '观众', avatarUrl: '', commentText: '加入' } });
  const frame = encodeFrame(result);
  assert.equal(frame.readUInt32LE(), frame.length - 4);
  assert.deepEqual(JSON.parse(frame.subarray(4).toString('utf8')), result);
});

test('进场和无效消息', () => {
  assert.equal(convertMessage({ method: 'WebcastMemberMessage', user: { id: 'a' } }, '').payload.interactType, 1);
  assert.equal(convertMessage({ method: 'WebcastChatMessage', user: {}, content: '加入' }, ''), null);
  assert.equal(convertMessage({ method: 'WebcastGiftMessage', user: { id: 'a' }, gift: { count: 10 } }, ''), null);
  assert.throws(() => encodeFrame({ text: 'x'.repeat(MAX_FRAME_SIZE) }));
});

test('礼物连击按组增量去重且价格为单价', () => {
  const converter = new MessageConverter();
  const msg = { id: 'msg', method: 'WebcastGiftMessage', user: { id: 'a' },
    gift: { id: 'g', name: '礼物', groupId: 'group', count: '1', price: 3, repeatEnd: 0 } };
  const first = converter.convert(msg, 'r');
  assert.equal(first.payload.giftCount, 1);
  assert.equal(first.payload.price, 30);
  assert.equal(converter.convert(msg, 'r'), null);
  msg.gift.count = '5';
  assert.equal(converter.convert(msg, 'r').payload.giftCount, 4);
  msg.gift.repeatEnd = 1;
  assert.equal(converter.convert(msg, 'r'), null);
  msg.gift.count = '3';
  assert.equal(converter.convert(msg, 'r'), null);
  msg.gift.groupId = 'new';
  assert.equal(converter.convert(msg, 'r').payload.giftCount, 3);
});

test('事件映射、消息去重与异常礼物拒绝', () => {
  const warnings = [];
  const converter = new MessageConverter({ onWarning: (...v) => warnings.push(v) });
  const msg = { id: '1', method: 'WebcastLikeMessage', user: { id: 'u' } };
  assert.equal(converter.convert(msg, 'r').payload.interactType, 6);
  assert.equal(converter.convert(msg, 'r'), null);
  assert.equal(converter.convert({ ...msg, id: '2', method: 'WebcastSocialMessage', socialAction: '1' }, 'r').payload.interactType, 2);
  assert.equal(converter.convert({ ...msg, id: '3', method: 'WebcastSocialMessage', socialAction: '3' }, 'r').payload.interactType, 3);
  assert.equal(converter.convert({ method: 'WebcastControlMessage', room: { status: 3 } }, 'r').eventType, 'live_end');
  assert.equal(converter.convert({ ...msg, method: 'WebcastGiftMessage', gift: { name: '礼物', count: 2, price: 1 } }, 'r'), null);
  assert.equal(warnings.length, 1);
});
