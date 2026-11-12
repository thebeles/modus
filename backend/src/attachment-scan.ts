import { createConnection } from 'node:net';
import { AppError } from './common';

const unavailable = () => new AppError('SCANNER_UNAVAILABLE', 'Проверка файлов временно недоступна.', 503);

export function attachmentScanMode() {
  return process.env.NODE_ENV === 'production' ? 'required' : process.env.ATTACHMENT_SCAN_MODE ?? 'disabled';
}

export async function scanUpload(bytes: Buffer) {
  const mode = attachmentScanMode();
  if (mode === 'disabled') return false;
  const path = process.env.CLAMD_SOCKET;
  const host = process.env.CLAMD_HOST;
  const port = Number(process.env.CLAMD_PORT ?? 3310);
  if (mode !== 'required' || (!path && (!host || !Number.isInteger(port) || port < 1 || port > 65535))) throw unavailable();

  await new Promise<void>((resolve, reject) => {
    const socket = path ? createConnection(path) : createConnection({ host, port });
    const timer = setTimeout(() => socket.destroy(unavailable()), 5000);
    let reply = '';
    socket.once('error', () => reject(unavailable()));
    socket.once('close', () => { clearTimeout(timer); reject(unavailable()); });
    socket.once('connect', () => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      socket.write('zINSTREAM\0');
      socket.write(length);
      socket.write(bytes);
      socket.write(Buffer.alloc(4));
    });
    socket.on('data', data => {
      reply += data.toString('utf8');
      if (reply.length > 4096) { socket.destroy(unavailable()); return; }
      const end = reply.indexOf('\0');
      if (end < 0) return;
      const result = reply.slice(0, end);
      if (result === 'stream: OK') resolve();
      else if (result.startsWith('stream: ') && result.endsWith(' FOUND')) {
        reject(new AppError('ATTACHMENT_REJECTED', 'Файл отклонён проверкой безопасности.', 422));
      } else reject(unavailable());
      socket.destroy();
    });
  });
  return true;
}
