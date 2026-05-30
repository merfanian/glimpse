declare const __BROWSER__: string;

// esbuild substitutes process.env.NODE_ENV at build time; declare its shape here.
declare const process: { env: { NODE_ENV: string } };

declare function cloneInto<T>(obj: T, targetScope: object): T;

declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
