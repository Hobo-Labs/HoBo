const allowedPhotoTypes: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

export type PhotoReadControl = {
  generation: number;
  activeReader: FileReader | null;
};

export type PhotoReadCallbacks = {
  setReading: (reading: boolean) => void;
  setDraftPhoto: (dataUrl: string) => void;
  setError: (message: string) => void;
  clearError: () => void;
  clearNotice: () => void;
};

export const invalidPhotoMessage =
  "Choose a PNG, JPEG, or WebP image no larger than 256 KB.";

export function clearPhotoFileInput(
  input: Pick<HTMLInputElement, "value"> | null,
) {
  if (input) {
    input.value = "";
  }
}

export function invalidatePhotoRead(
  control: PhotoReadControl,
  callbacks: Pick<PhotoReadCallbacks, "setReading">,
) {
  control.generation += 1;
  control.activeReader?.abort();
  control.activeReader = null;
  callbacks.setReading(false);
}

export function canSubmitSettings(readingPhoto: boolean, saving: boolean) {
  return !readingPhoto && !saving;
}

export type PhotoDataUrlParser = (
  result: string | ArrayBuffer | null,
) => string | null;

function startPhotoFileRead(
  control: PhotoReadControl,
  callbacks: PhotoReadCallbacks,
  file: File,
  parseDataUrl: PhotoDataUrlParser,
) {
  const generation = control.generation;
  const reader = new FileReader();
  control.activeReader = reader;
  callbacks.setReading(true);
  callbacks.clearError();
  callbacks.clearNotice();
  reader.onerror = () => {
    if (generation !== control.generation) return;
    control.activeReader = null;
    callbacks.setReading(false);
    callbacks.setError("The image could not be read.");
  };
  reader.onload = () => {
    if (generation !== control.generation) return;
    control.activeReader = null;
    callbacks.setReading(false);
    const dataUrl = parseDataUrl(reader.result ?? null);
    if (!dataUrl) {
      callbacks.setError("The image could not be read.");
      return;
    }
    callbacks.setDraftPhoto(dataUrl);
    callbacks.clearError();
    callbacks.clearNotice();
  };
  reader.readAsDataURL(file);
}

export function handlePhotoFileChange(
  control: PhotoReadControl,
  callbacks: PhotoReadCallbacks,
  file: File | undefined,
  maxPhotoBytes: number,
  parseDataUrl: PhotoDataUrlParser,
) {
  invalidatePhotoRead(control, callbacks);
  if (!file) return;
  if (!allowedPhotoTypes.includes(file.type) || file.size > maxPhotoBytes) {
    callbacks.setError(invalidPhotoMessage);
    return;
  }
  startPhotoFileRead(control, callbacks, file, parseDataUrl);
}