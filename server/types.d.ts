declare module 'node-webpmux' {
  export interface WebpImageInstance {
    exif?: Buffer;
    load(input: Buffer | string): Promise<void>;
    save(output: string | null): Promise<Buffer>;
  }

  export interface WebpMuxDefault {
    Image: new () => WebpImageInstance;
  }

  const webpmux: WebpMuxDefault;
  export default webpmux;
}
