import { existsSync, readFileSync, statSync } from "node:fs";
import type { DecodedImage, ImageDecoder } from "./types";

/**
 * Headless host: there is no native image pipeline, so "decoding" means reading
 * the file and answering the two questions the service layer actually asks —
 * does it exist, and what does it look like as a data URL.
 */
export class FsImageDecoder implements ImageDecoder {
  fromPath(path: string): DecodedImage {
    const readable = (() => {
      try {
        return existsSync(path) && statSync(path).isFile();
      } catch {
        return false;
      }
    })();
    if (!readable) {
      return { isEmpty: () => true, toDataUrl: () => "" };
    }
    const bytes = readFileSync(path);
    return {
      isEmpty: () => bytes.byteLength === 0,
      toDataUrl: () => `data:image/png;base64,${bytes.toString("base64")}`,
    };
  }
}
