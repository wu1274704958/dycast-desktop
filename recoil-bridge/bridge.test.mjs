import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

test('Dycast 批次经 WebSocket 和 Windows 管道转发', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dycast-recoil-'));
  const discovery = path.join(dir, 'discovery.json');
  const pipeName = `\\\\.\\pipe\\RecoilLiveGameplay-${process.pid}`;
  const pipeServer = net.createServer();
  let child;
  let ws;
  try {
    pipeServer.listen(pipeName);
    await once(pipeServer, 'listening');
    await writeFile(discovery, JSON.stringify({ protocolVersion: 1, transport: 'windows-named-pipe', pipeName }));
    const portServer = net.createServer();
    portServer.listen(0, '127.0.0.1');
    await once(portServer, 'listening');
    const port = portServer.address().port;
    await new Promise(resolve => portServer.close(resolve));
    const connected = once(pipeServer, 'connection');
    child = spawn(process.execPath, ['bridge.mjs', discovery], { cwd: import.meta.dirname,
      env: { ...process.env, RECOIL_DYCAST_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const [pipe] = await connected;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket server did not start')), 5000);
      const attempt = () => {
        ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.once('open', () => { clearTimeout(timeout); resolve(); });
        ws.once('error', () => setTimeout(attempt, 50));
      };
      attempt();
    });
    const received = once(pipe, 'data');
    ws.send(JSON.stringify({ roomNum: '123' }));
    ws.send(JSON.stringify([{ method: 'WebcastChatMessage', user: { id: '42', name: '观众' }, content: '加入' }]));
    const [frame] = await received;
    assert.equal(frame.readUInt32LE(), frame.length - 4);
    const message = JSON.parse(frame.subarray(4).toString('utf8'));
    assert.equal(message.roomId, '123');
    assert.equal(message.payload.userId, 'douyin:42');
    assert.equal(message.payload.commentText, '加入');
    const giftReceived = once(pipe, 'data');
    ws.send(JSON.stringify([{ id: 'm1', method: 'WebcastGiftMessage', user: { id: '42' },
      gift: { id: 'g1', name: '礼物', groupId: '123', count: '3', price: 2 } }]));
    const [giftFrame] = await giftReceived;
    const gift = JSON.parse(giftFrame.subarray(4).toString('utf8'));
    assert.equal(gift.eventType, 'gift_send');
    assert.equal(gift.payload.giftCount, 3);
    assert.equal(gift.payload.price, 20);
    const reconnected = once(pipeServer, 'connection');
    pipe.destroy();
    const [nextPipe] = await reconnected;
    const nextReceived = once(nextPipe, 'data');
    ws.send(JSON.stringify([{ method: 'WebcastMemberMessage', user: { id: '42' } }]));
    const [nextFrame] = await nextReceived;
    assert.equal(JSON.parse(nextFrame.subarray(4).toString('utf8')).payload.interactType, 1);
    nextPipe.destroy();
  } finally {
    ws?.terminate();
    child?.kill();
    await new Promise(resolve => pipeServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
