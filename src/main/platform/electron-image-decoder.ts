import { nativeImage } from "electron";
import type { DecodedImage, ImageDecoder } from "./types";

/** Electron host: hands the caller a real `NativeImage`. */
export class ElectronImageDecoder implements ImageDecoder {
  fromPath(path: string): DecodedImage {
    const image = nativeImage.createFromPath(path);
    return {
      native: image,
      isEmpty: () => image.isEmpty(),
      toDataUrl: () => image.toDataURL(),
    };
  }
}
