/**
 * Dev-only: WGSL errors surface as "invalid pipeline" at draw time and lost
 * devices surface as a black canvas, so both are put on screen instead.
 */
const lines = new Set<string>();

export function report(text: string): void {
  if (!__DEV__ || lines.has(text)) {
    return;
  }
  lines.add(text);
  let box = document.querySelector<HTMLDivElement>('.fatal');
  if (box === null) {
    box = document.createElement('div');
    box.className = 'fatal';
    document.body.append(box);
  }
  box.textContent = [...lines].slice(0, 12).join('\n');
  console.error(text);
}

export function watchDevice(device: GPUDevice): void {
  if (!__DEV__) {
    return;
  }
  device.onuncapturederror = (ev) => report(ev.error.message);
  void device.lost.then((info) => report(`device lost: ${info.reason} — ${info.message}`));
  window.addEventListener('error', (ev) => report(String(ev.message)));
  window.addEventListener('unhandledrejection', (ev) => report(String(ev.reason)));
}

export async function checkShaders(modules: GPUShaderModule[]): Promise<void> {
  if (!__DEV__) {
    return;
  }
  for (const m of modules) {
    const info = await m.getCompilationInfo();
    for (const msg of info.messages) {
      if (msg.type !== 'info') {
        report(`${msg.type} ${msg.lineNum}:${msg.linePos} — ${msg.message}`);
      }
    }
  }
}
