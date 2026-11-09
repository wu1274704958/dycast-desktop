import fs from 'node:fs/promises';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { MessageConverter, encodeFrame } from './protocol.mjs';

const discoveryPath = process.argv[2] || process.env.RECOIL_LIVE_GAMEPLAY_DISCOVERY;
if (!discoveryPath) {
  console.error('用法: npm start -- "引擎 write-dir\\live\\live-gameplay.json"');
  process.exit(1);
}
if (process.platform !== 'win32') {
  console.error('游戏命名管道接收端目前仅支持 Windows');
  process.exit(1);
}

const port = Number(process.env.RECOIL_DYCAST_PORT || 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效的 RECOIL_DYCAST_PORT');
let pipe;
let roomId = '';
let connecting = false;
let dropped = 0;
let sent = 0;
let lastConnectionError = '';
const fenPerDiamond = Number(process.env.RECOIL_DOUYIN_FEN_PER_DIAMOND ?? 10);
const converter = new MessageConverter({
  fenPerDiamond,
  onWarning: (reason, detail) => console.warn('[转换丢弃]', reason, detail ?? ''),
});
const server = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: 1024 * 1024 });

async function connectPipe() {
  if (connecting || pipe) return;
  connecting = true;
  try {
    const discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8'));
    if (discovery.protocolVersion !== 1 || discovery.transport !== 'windows-named-pipe' ||
        typeof discovery.pipeName !== 'string' || !/^\\\\\.\\pipe\\RecoilLiveGameplay-\d+$/i.test(discovery.pipeName)) {
      throw new Error('无效的引擎管道发现文件');
    }
    const socket = net.createConnection(discovery.pipeName);
    pipe = socket;
    socket.on('connect', () => { lastConnectionError = ''; console.log('[管道] 已连接游戏', discovery.pipeName); });
    // The pipe is duplex; always drain engine output to avoid blocking it.
    socket.on('data', () => {});
    socket.on('error', error => {
      if (lastConnectionError !== error.code) console.warn('[管道] 连接失败，稍后重试:', error.code);
      lastConnectionError = error.code;
    });
    socket.on('close', () => { if (pipe === socket) { pipe = undefined; console.log('[管道] 已断开，等待重连'); } });
  } catch (error) {
    const reason = error.code || error.message;
    if (lastConnectionError !== reason) console.warn('[发现] 等待游戏发现文件:', reason);
    lastConnectionError = reason;
  } finally {
    connecting = false;
  }
}

function forward(envelope) {
  if (!pipe || pipe.connecting || pipe.destroyed || pipe.writableLength > 1024 * 1024) {
    if (++dropped === 1 || dropped % 100 === 0) console.warn(`[转发] 管道未连接或拥塞，已丢弃 ${dropped} 条`);
    return;
  }
  try {
    pipe.write(encodeFrame(envelope));
    sent++;
    if (envelope.eventType === 'gift_send') {
      console.log('[转发] 礼物', envelope.payload.giftName, '数量', envelope.payload.giftCount, '单价(分)', envelope.payload.price);
    } else if (sent === 1 || sent % 100 === 0) {
      console.log('[转发] 已写入管道', sent, '条，最近类型', envelope.eventType);
    }
  } catch (error) { console.warn('[转发] 丢弃无效消息:', error.message); }
}

server.on('connection', ws => {
  console.log('Dycast 已连接');
  ws.on('error', error => console.error('WebSocket 错误:', error.message));
  ws.on('message', raw => {
    let value;
    try { value = JSON.parse(raw.toString()); } catch { return; }
    if (!Array.isArray(value)) {
      if (value && typeof value === 'object') {
        roomId = String(value.roomNum || value.roomId || '');
        console.log('[房间] 已收到房间信息', roomId);
        if (value.status === 2) forward({ protocolVersion: 1, eventType: 'live_start', roomId, occurredAtMs: Date.now(), payload: {} });
      }
      return;
    }
    for (const message of value) {
      const envelope = converter.convert(message, roomId);
      if (!envelope) continue;
      forward(envelope);
    }
  });
});
server.on('error', error => { console.error('转发服务错误:', error.message); process.exitCode = 1; clearInterval(timer); });
server.on('listening', () => console.log(`[启动] 等待 Dycast 连接 ws://127.0.0.1:${port}，礼物换算 ${fenPerDiamond} 分/抖币`));
const timer = setInterval(connectPipe, 1000);
connectPipe();
