import { Controller, Get, Inject, Injectable, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Response } from 'express';
import { AuthRequest } from './auth';
import { AppError, Database, forbidden, invalid, missing, throttle } from './common';
import { Policy, Principal } from './policy';

export const maxFileBytes = () => Math.min(5_242_880, Math.max(1024, Number(process.env.ATTACHMENT_MAX_BYTES) || 5_242_880));
const unavailable = () => new AppError('STORAGE_UNAVAILABLE', 'Хранилище временно недоступно.', 503);
const types: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain' };

export function fileType(name: string, content: Buffer, production = process.env.NODE_ENV === 'production') {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const jpeg = Buffer.from([255, 216, 255]);
  const signatures: Record<string, Buffer> = { png, jpg: jpeg, jpeg, pdf: Buffer.from('%PDF-') };
  if (production && extension === 'pdf') return null;
  if (extension === 'txt') {
    const text = content.toString('utf8');
    // eslint-disable-next-line no-control-regex -- reject binary control bytes in text uploads.
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(text) ? null : types.txt;
  }
  const signature = signatures[extension];
  return signature && content.subarray(0, signature.length).equals(signature) ? types[extension] : null;
}

export interface FileStorage {
  write(key: string, buffer: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

@Injectable()
export class LocalStorage implements FileStorage {
  private directory() { return resolve('..', process.env.STORAGE_DIR || '.storage'); }
  private path(key: string) {
    if (!/^[a-f0-9-]{36}$/.test(key)) throw unavailable();
    return resolve(this.directory(), key);
  }
  async write(key: string, buffer: Buffer) {
    await mkdir(this.directory(), { recursive: true, mode: 0o700 });
    await writeFile(this.path(key), buffer, { flag: 'wx', mode: 0o600 });
  }
  read(key: string) { return readFile(this.path(key)); }
  remove(key: string) { return unlink(this.path(key)); }
}

@Injectable()
export class Files {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy,
    @Inject(LocalStorage) private readonly storage: FileStorage) {}

  async upload(user: Principal, file?: Express.Multer.File) {
    if (user.role === 'ADMIN') throw forbidden();
    await throttle(this.db, `upload:${user.id}`, 25, 3600);
    if (!file?.buffer?.length || file.size > maxFileBytes()) throw invalid('Выберите файл размером до 5 МБ.');
    const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const filename = decoded.includes('�') ? file.originalname : decoded;
    const name = filename.replace(/[^\p{L}\p{N}._ ()-]/gu, '_').slice(-120);
    const mediaType = fileType(name, file.buffer);
    if (!mediaType) throw invalid('Формат файла не разрешён или содержимое не соответствует расширению.');
    const storageKey = randomUUID();
    try { await this.storage.write(storageKey, file.buffer); } catch { throw unavailable(); }
    try {
      return await this.db.attachment.create({ data: { name, mediaType, bytes: file.size, storageKey, uploaderId: user.id },
        select: { id: true, name: true, mediaType: true, bytes: true } });
    } catch (error) {
      await this.storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async download(user: Principal, item: string) {
    const record = await this.db.attachment.findFirst({ where: { id: item, OR: [
      { appealId: null, uploaderId: user.id }, { appeal: { is: this.policy.appeals(user) } },
    ] } });
    if (!record) throw missing();
    if (process.env.NODE_ENV === 'production' && record.mediaType === types.pdf) throw missing();
    try { return { record, bytes: await this.storage.read(record.storageKey) }; } catch { throw unavailable(); }
  }
}

@Controller('attachments')
export class FileController {
  constructor(@Inject(Files) private readonly files: Files) {}
  @Post(['init', 'complete'])
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5_242_880, files: 1, parts: 2 } }))
  upload(@Req() req: AuthRequest, @UploadedFile() file?: Express.Multer.File) { return this.files.upload(req.user, file); }
  @Get(':id/download') async download(@Req() req: AuthRequest, @Param('id') item: string, @Res() res: Response) {
    const { record, bytes } = await this.files.download(req.user, item);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(record.name).replace(/[()']/g, ch => '%' + ch.charCodeAt(0).toString(16))}`);
    res.type(record.mediaType).send(bytes);
  }
}
