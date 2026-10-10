// This module is copied verbatim into .github/packager/build.mjs.
// Importing it is inert. Repository code runs only from main(), in GitHub Actions.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

export const TOOLCHAIN = Object.freeze({ electron: '44.7.0', builder: '26.15.3', pyinstaller: '6.16.0' });
export const TARGETS = Object.freeze({
  'mac-arm64': { runner: 'macos-15', platform: 'darwin', arch: 'arm64' },
  'mac-x64': { runner: 'macos-15-intel', platform: 'darwin', arch: 'x64' },
  'win-x64': { runner: 'windows-2025', platform: 'win32', arch: 'x64' },
});

function fail(message) { const error = new Error(message); error.code = 'INVALID_CONFIG'; throw error; }
function text(value, fallback, label, max = 160) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max) fail(`${label}必须是长度不超过 ${max} 的字符串。`);
  return value;
}

export function relativePath(value, label, allowDot = true) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\:\x00-\x1f\x7f]/u.test(value) || path.posix.isAbsolute(value)) fail(`${label}必须是项目内的相对路径。`);
  if (value === '.' && allowDot) return value;
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/u.test(segment) || !/^[\p{L}\p{N}\p{M}._ ()&+!@#-]+$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment) || segment.toLowerCase() === '.git')) fail(`${label}含有不安全或不兼容 Windows 的路径片段。`);
  return segments.join('/');
}

export function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('打包配置必须是对象。');
  const kind = text(input.kind, '', '项目类型');
  if (!['electron', 'web', 'python'].includes(kind)) fail('当前只支持 Electron、静态 Web 和 Python 桌面项目。');
  const appName = text(input.appName, 'My App', '软件名称', 80).trim();
  if (!appName || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._()&+!@#-]*$/u.test(appName) || /[. ]$/u.test(appName) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(appName)) fail('软件名称包含不安全字符或系统保留名称。请使用文字、数字、空格及常见标点，不要包含引号、路径符号或花括号。');
  const appId = text(input.appId, 'com.example.myapp', '应用标识', 160);
  if (!/^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)+$/u.test(appId)) fail('应用标识须使用反向域名格式，例如 com.example.myapp。');
  const version = text(input.version, '1.0.0', '版本号', 64);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(version);
  if (!match || match.slice(1, 4).some(n => Number(n) > 65535) || match[4]?.split('.').some(part => /^0\d+$/u.test(part))) fail('版本号须为有效的 1.0.0、1.0.0-beta.1 或 1.0.0+build.1，且各版本数字不超过 65535。');
  const projectDirInput = text(input.projectDir, '', '项目目录');
  const projectDir = !projectDirInput || projectDirInput === '.' ? '' : relativePath(projectDirInput, '项目目录');
  const outputDirInput = text(input.outputDir, kind === 'web' ? 'dist' : '', '输出目录');
  const outputDir = outputDirInput ? relativePath(outputDirInput, '输出目录') : kind === 'web' ? 'dist' : '';
  const buildCommand = text(input.buildCommand, '', '构建脚本', 100);
  if (buildCommand && !/^[a-zA-Z0-9][a-zA-Z0-9:_.-]*$/u.test(buildCommand)) fail('构建脚本只填写 package.json 中的脚本名，例如 build；不能填写完整命令。');
  if (kind === 'python' && buildCommand) fail('Python 适配器不接受自定义命令；请使用项目的依赖声明和明确的 .py 入口。');
  const packageManager = text(input.packageManager, kind === 'python' ? 'pip' : 'npm', '包管理器');
  if (kind === 'python' ? !['pip', ''].includes(packageManager) : !['npm', ''].includes(packageManager)) fail('当前 Node 项目仅支持 npm，Python 项目仅支持 pip。');
  const entry = text(input.entry, kind === 'python' ? '' : 'index.html', '入口文件').replace(/^\.\//u, '');
  if (entry) relativePath(entry, '入口文件', false);
  if (kind === 'python' && !/\.pyw?$/iu.test(entry)) fail('Python 项目必须填写明确的 .py 或 .pyw 入口文件。');
  const requestedTargets = input.targets ?? Object.keys(TARGETS);
  if (!Array.isArray(requestedTargets) || requestedTargets.length === 0 || requestedTargets.length > 3 || requestedTargets.some(target => typeof target !== 'string' || !Object.hasOwn(TARGETS, target)) || new Set(requestedTargets).size !== requestedTargets.length) fail('请选择不重复的 Mac Apple Silicon、Mac Intel 或 Windows x64 目标。');
  const targets = Object.keys(TARGETS).filter(target => requestedTargets.includes(target));
  if (input.pythonWindowed !== undefined && typeof input.pythonWindowed !== 'boolean') fail('Python 窗口模式必须是布尔值。');
  const pythonWindowed = input.pythonWindowed ?? true;
  if (kind === 'python' && !pythonWindowed && targets.some(target => target.startsWith('mac-'))) fail('Mac .app 安装包需要 Python 窗口模式；命令行程序请仅选择 Windows 或先增加图形入口。');
  const signing = text(input.signing, 'unsigned', '签名方式');
  if (signing !== 'unsigned') fail('此版本生成未正式签名的安装包；证书签名和 Mac 公证需要单独配置。');
  return { kind, projectDir, appName, appId, version, entry, buildCommand, outputDir, packageManager: kind === 'python' ? 'pip' : 'npm', targets, pythonWindowed, signing };
}

export function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export async function resolveContained(root, relative, label = '文件') {
  relative ||= '.';
  relativePath(relative, label);
  const realRoot = await fsp.realpath(root);
  const resolved = await fsp.realpath(path.resolve(realRoot, relative));
  if (!isWithin(realRoot, resolved)) throw new Error(`${label}通过符号链接越过了项目目录：${relative}`);
  return resolved;
}

function cleanEnvironment() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)|^(?:CSC_|WIN_CSC_|APPLE_)/iu.test(key))), CI: 'true', CSC_IDENTITY_AUTO_DISCOVERY: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
}

export async function run(command, args, cwd, label, timeoutMs = 30 * 60 * 1000) {
  console.log(`\n[packager] ${label}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: cleanEnvironment(), shell: false, stdio: 'inherit', windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(new Error(`${label}无法启动：${error.message}`)); });
    child.once('close', (code, signal) => { clearTimeout(timer); code === 0 && !timedOut ? resolve() : reject(new Error(`${label}${timedOut ? '超时' : `失败（退出码 ${code ?? signal}）`}。请查看上方原始日志。`)); });
  });
}

function npmCli() {
  const bin = path.dirname(process.execPath);
  const candidates = [path.join(bin, 'node_modules/npm/bin/npm-cli.js'), path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js')];
  try { candidates.push(fs.realpathSync(path.join(bin, 'npm'))); } catch {}
  const found = candidates.find(candidate => candidate.endsWith('npm-cli.js') && fs.existsSync(candidate));
  if (!found) throw new Error('找不到 setup-node 安装的 npm-cli.js；请检查 Node 安装步骤。');
  return found;
}
function npm(args, cwd, label) { return run(process.execPath, [npmCli(), ...args], cwd, label); }
async function readJson(filename) { return JSON.parse((await fsp.readFile(filename, 'utf8')).replace(/^\uFEFF/u, '')); }
async function fileExists(filename) { try { return (await fsp.stat(filename)).isFile(); } catch { return false; } }

export async function verifyNodeProject(project, config) {
  const manifestPath = await resolveContained(project, 'package.json', 'Node 项目清单');
  const pkg = await readJson(manifestPath);
  let lockfile = null;
  for (const lock of ['package-lock.json', 'npm-shrinkwrap.json']) if (await fileExists(path.join(project, lock))) { await resolveContained(project, lock, 'npm 锁文件'); lockfile = lock; }
  if (!lockfile) for (const lock of ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']) if (await fileExists(path.join(project, lock))) throw new Error('项目只提供 Yarn / pnpm / Bun 锁文件，不能用 npm 自动替代其依赖解析。请先提供独立的 npm 项目或对应专用配方。');
  if (pkg.packageManager && !String(pkg.packageManager).startsWith('npm@')) throw new Error('项目指定了其他包管理器，当前 Node 适配器仅支持 npm。');
  if (pkg.workspaces) throw new Error('当前适配器不自动构建 npm workspaces；请先提供独立项目和对应锁文件。');
  if (config.buildCommand && (typeof pkg.scripts?.[config.buildCommand] !== 'string' || !Object.hasOwn(pkg.scripts, config.buildCommand))) throw new Error(`package.json 中不存在构建脚本 ${config.buildCommand}。`);
  if (config.kind === 'electron' && !pkg.dependencies?.['electron-builder'] && !pkg.devDependencies?.['electron-builder']) throw new Error('项目没有声明 electron-builder。Electron Forge、Tauri 等需要专门适配。');
  return { package: pkg, installCommand: lockfile ? 'ci' : 'install', lockfile };
}

async function installNodeProject(project, config) {
  const plan = await verifyNodeProject(project, config);
  if (!plan.lockfile) console.log('[packager] 未发现 npm 锁文件，云端将自动解析依赖并生成临时 package-lock.json；依赖解析结果可能随时间变化。');
  await npm([plan.installCommand, '--include=dev', '--no-audit', '--no-fund'], project, plan.lockfile ? '根据锁文件安装 Node 依赖' : '自动准备 Node 依赖并生成临时锁文件');
  return plan;
}

export function builderArgs(config, target, output, builderVersion = TOOLCHAIN.builder) {
  const major = Number(builderVersion.split('.')[0]);
  if (!Number.isInteger(major) || major < 24 || major > 26) throw new Error(`当前适配器支持 electron-builder 24–26，项目使用 ${builderVersion}。请升级到受支持版本或增加对应配方。`);
  const spec = TARGETS[target];
  if (!spec) throw new Error('未知构建目标。');
  const args = [spec.platform === 'darwin' ? '--mac' : '--win', spec.platform === 'darwin' ? 'dmg' : 'nsis', `--${spec.arch}`, '--publish', 'never', `-c.directories.output=${output}`, `-c.appId=${config.appId}`, `-c.productName=${config.appName}`, `-c.extraMetadata.version=${config.version}`, '-c.forceCodeSigning=false'];
  if (spec.platform === 'darwin') args.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false', '-c.mac.notarize=false', '-c.mac.forceCodeSigning=false');
  else args.push('-c.win.signAndEditExecutable=false', '-c.win.forceCodeSigning=false');
  return args;
}

async function buildElectron(project, config, target, output) {
  await installNodeProject(project, config);
  if (config.buildCommand) await npm(['run', config.buildCommand, '--'], project, `运行 npm 脚本 ${config.buildCommand}`);
  const builderPath = await resolveContained(project, 'node_modules/electron-builder/cli.js', 'electron-builder');
  const builderPkg = await readJson(path.join(path.dirname(builderPath), 'package.json'));
  await run(process.execPath, [builderPath, ...builderArgs(config, target, output, builderPkg.version)], project, '构建 Electron 安装包');
}

// The renderer never receives Node APIs, credentials or a general IPC bridge.
export const WEB_MAIN = String.raw`const { app, BrowserWindow, protocol, net, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const root = require('node:fs').realpathSync(path.join(__dirname, 'web'));
const inside = p => { const r = path.relative(root, p); return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); };
function openWindow() {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { try { const u = new URL(url); if (u.protocol !== 'app:' || u.hostname !== 'bundle') event.preventDefault(); } catch { event.preventDefault(); } });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://bundle/').catch(console.error);
}
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('app', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'bundle' || !['GET', 'HEAD'].includes(request.method)) return new Response('Forbidden', { status: 403 });
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\\') || decoded.includes('\0')) return new Response('Forbidden', { status: 403 });
      let filename = path.resolve(root, '.' + decoded);
      if (!inside(filename)) return new Response('Forbidden', { status: 403 });
      let info;
      try { info = await fs.stat(filename); } catch {}
      if (info?.isDirectory()) filename = path.join(filename, 'index.html');
      else if (!info && !path.extname(filename)) filename = path.join(root, 'index.html');
      const real = await fs.realpath(filename);
      if (!inside(real)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(real).href);
    } catch { return new Response('Not found', { status: 404 }); }
  });
  openWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) openWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
`;

const STATIC_EXTENSIONS = new Set('.html .htm .css .js .mjs .json .wasm .png .jpg .jpeg .gif .webp .svg .ico .avif .bmp .woff .woff2 .ttf .otf .eot .mp3 .mp4 .webm .ogg .wav .pdf .txt .md .xml .webmanifest .vtt .csv .tsv .glb .gltf .bin .onnx .obj .mtl .stl .hdr .ktx .ktx2 .basis .data'.split(' '));
export async function copyStatic(source, destination, { compiledOutput = false } = {}) {
  const realSource = await fsp.realpath(source);
  let count = 0;
  let bytes = 0;
  async function visit(current, out) {
    await fsp.mkdir(out, { recursive: true });
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json'].includes(entry.name)) continue;
      const from = path.join(current, entry.name);
      const to = path.join(out, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`静态资源不能包含符号链接：${path.relative(realSource, from)}`);
      if (entry.isDirectory()) await visit(from, to);
      else if (entry.isFile()) {
        if (!compiledOutput && !STATIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !/^LICENSE(?:\..*)?$/iu.test(entry.name)) throw new Error(`静态目录包含无法确认用途的文件：${path.relative(realSource, from)}。不会静默丢弃；请提供经过构建、只包含网页资源的独立输出目录或专用资源配方。`);
        const stat = await fsp.stat(from);
        bytes += stat.size;
        if (++count > 50000 || bytes > 1024 * 1024 * 1024) throw new Error('静态资源超过 50,000 个文件或 1 GiB，请缩小输出目录。');
        await fsp.copyFile(from, to);
      }
    }
  }
  await visit(realSource, destination);
  if (!await fileExists(path.join(destination, 'index.html'))) throw new Error('静态输出根目录没有 index.html；SSR/服务端应用需要专门的桌面适配。');
  return { count, bytes };
}

async function buildWeb(project, config, target, scratch, output) {
  const nodeProject = await fileExists(path.join(project, 'package.json'));
  if (nodeProject) {
    if (!config.buildCommand) throw new Error('Node Web 项目必须选择明确的静态构建脚本。');
    await installNodeProject(project, config);
    await npm(['run', config.buildCommand, '--'], project, `构建静态站点：${config.buildCommand}`);
  } else if (config.buildCommand) throw new Error('没有 package.json，不能执行 npm 构建脚本。');
  const webOutput = await resolveContained(project, config.outputDir, '静态输出目录');
  const wrapper = path.join(scratch, 'desktop');
  await fsp.mkdir(wrapper, { recursive: true });
  await copyStatic(webOutput, path.join(wrapper, 'web'), { compiledOutput: nodeProject && config.outputDir !== '.' });
  const pkg = { name: 'github-packager-web', productName: config.appName, version: config.version, description: `${config.appName} desktop application`, author: 'Application author', private: true, main: 'main.cjs', devDependencies: { electron: TOOLCHAIN.electron, 'electron-builder': TOOLCHAIN.builder }, build: { appId: config.appId, asar: true, files: ['main.cjs', 'web/**/*', 'package.json'], mac: { category: 'public.app-category.utilities' }, nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true } } };
  await fsp.writeFile(path.join(wrapper, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await fsp.writeFile(path.join(wrapper, 'main.cjs'), WEB_MAIN);
  await npm(['install', '--include=dev', '--no-audit', '--no-fund'], wrapper, '安装固定版本的桌面打包工具');
  await run(process.execPath, [path.join(wrapper, 'node_modules/electron-builder/cli.js'), ...builderArgs(config, target, output)], wrapper, '将静态站点打包成桌面安装包');
}

export function innoScript(config, source, output, stem) {
  if ([source, output, stem].some(value => typeof value !== 'string' || /["\r\n\x00]/u.test(value))) throw new Error('Inno Setup 路径包含不安全字符。');
  const id = config.appId.replaceAll('.', '-');
  return `; Generated by GitHub Packager. No shell commands or external downloads.\n[Setup]\nAppId=${config.appId}\nAppName=${config.appName}\nAppVersion=${config.version}\nVersionInfoVersion=${config.version.split(/[+-]/u)[0]}.0\nDefaultDirName={localappdata}\\Programs\\${id}\nDefaultGroupName=${config.appName}\nPrivilegesRequired=lowest\nArchitecturesAllowed=x64compatible\nArchitecturesInstallIn64BitMode=x64compatible\nOutputDir=${output}\nOutputBaseFilename=${stem}\nCompression=lzma2\nSolidCompression=yes\nWizardStyle=modern\nUninstallDisplayIcon={app}\\${config.appName}.exe\nDisableProgramGroupPage=yes\n[Files]\nSource: "${source}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs\n[Icons]\nName: "{autoprograms}\\${config.appName}"; Filename: "{app}\\${config.appName}.exe"; WorkingDir: "{app}"\n[Run]\nFilename: "{app}\\${config.appName}.exe"; Description: "Launch ${config.appName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent\n`;
}

function innoCompiler() {
  const candidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map(base => path.join(base, 'Inno Setup 6', 'ISCC.exe'));
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'ISCC.exe'));
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('此 Windows runner 缺少 Inno Setup 6，请检查 GitHub runner 镜像或增加固定版本安装步骤。');
  return found;
}

export function pythonProjectInstallable(pyproject) {
  // pyproject.toml also configures tools (ruff, pytest, etc.); its presence alone does not mean pip install . is valid.
  return typeof pyproject === 'string' && /^\s*\[(?:project|build-system|tool\.poetry)\]\s*(?:#.*)?$/mu.test(pyproject);
}

async function buildPython(project, config, target, scratch, output) {
  const entry = await resolveContained(project, config.entry, 'Python 入口');
  if (!await fileExists(entry)) throw new Error('Python 入口不是普通文件。');
  const envDir = path.join(scratch, 'venv');
  await run('python', ['-m', 'venv', envDir], project, '创建独立 Python 构建环境');
  const python = path.join(envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (await fileExists(path.join(project, 'requirements.txt'))) {
    const req = await resolveContained(project, 'requirements.txt', 'Python 依赖文件');
    await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', req], project, '安装 requirements.txt 依赖');
  }
  const pyprojectPath = path.join(project, 'pyproject.toml');
  const pyproject = await fileExists(pyprojectPath) ? await fsp.readFile(await resolveContained(project, 'pyproject.toml', 'Python 项目清单'), 'utf8') : '';
  if (pythonProjectInstallable(pyproject) || await fileExists(path.join(project, 'setup.py'))) await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '.'], project, '安装 Python 项目及其依赖');
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', `pyinstaller==${TOOLCHAIN.pyinstaller}`], project, '安装固定版本的 PyInstaller');
  const dist = path.join(scratch, 'python-dist');
  const args = ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--noupx', '--name', config.appName, '--distpath', dist, '--workpath', path.join(scratch, 'python-work'), '--specpath', scratch];
  if (config.pythonWindowed) args.push('--windowed');
  if (process.platform === 'darwin') args.push('--osx-bundle-identifier', config.appId, '--target-architecture', TARGETS[target].arch === 'x64' ? 'x86_64' : 'arm64');
  // Common data directories only; hidden imports and arbitrary layouts need a custom recipe.
  for (const name of ['assets', 'resources', 'data', 'icons', 'ui', 'templates', 'static']) {
    try {
      if ((await fsp.stat(path.join(project, name))).isDirectory()) {
        const contained = await resolveContained(project, name, 'Python 资源目录');
        args.push('--add-data', `${contained}${path.delimiter}${name}`);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  args.push(entry);
  await run(python, args, project, '构建 Python 独立应用');
  await fsp.mkdir(output, { recursive: true });
  const stem = `${config.appId}-${config.version}-${target}`;
  if (process.platform === 'darwin') {
    const app = await resolveContained(dist, `${config.appName}.app`, 'PyInstaller 应用');
    const stage = path.join(scratch, 'dmg-stage');
    await fsp.mkdir(stage);
    await fsp.cp(app, path.join(stage, `${config.appName}.app`), { recursive: true, dereference: false, verbatimSymlinks: true });
    await fsp.symlink('/Applications', path.join(stage, 'Applications'));
    await run('/usr/bin/hdiutil', ['create', '-volname', config.appName, '-srcfolder', stage, '-ov', '-format', 'UDZO', path.join(output, `${stem}.dmg`)], scratch, '生成 Mac DMG 安装包');
  } else {
    const app = await resolveContained(dist, config.appName, 'PyInstaller 应用');
    if (!await fileExists(path.join(app, `${config.appName}.exe`))) throw new Error('PyInstaller 未产生预期的 Windows 可执行文件。');
    const iss = path.join(scratch, 'installer.iss');
    await fsp.writeFile(iss, `\ufeff${innoScript(config, app, output, stem)}`, 'utf8');
    await run(innoCompiler(), ['/Qp', iss], scratch, '生成 Windows 安装程序');
  }
}

export async function collectArtifacts(output, destination, config, target) {
  await fsp.mkdir(destination, { recursive: true });
  const extension = target.startsWith('mac-') ? '.dmg' : '.exe';
  const artifacts = [];
  for (const item of await fsp.readdir(output, { withFileTypes: true })) {
    if (!item.name.toLowerCase().endsWith(extension)) continue;
    if (!item.isFile() || /[\r\n]/u.test(item.name)) throw new Error('安装包必须是普通文件，不能是符号链接或目录。');
    const file = path.join(output, item.name);
    const stat = await fsp.stat(file);
    if (!stat.size) throw new Error(`安装包为空：${item.name}`);
    await fsp.copyFile(file, path.join(destination, item.name));
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    artifacts.push({ filename: item.name, size: stat.size, sha256: hash.digest('hex') });
  }
  if (artifacts.length === 0) throw new Error(`构建步骤完成，但没有生成 ${extension} 安装包。请检查项目的 electron-builder 配置或构建日志。`);
  artifacts.sort((a, b) => a.filename.localeCompare(b.filename));
  await fsp.writeFile(path.join(destination, 'SHA256SUMS.txt'), artifacts.map(file => `${file.sha256}  ${file.filename}`).join('\n') + '\n');
  await fsp.writeFile(path.join(destination, 'build-manifest.json'), JSON.stringify({ schema: 1, appName: config.appName, appId: config.appId, version: config.version, kind: config.kind, target, sourceCommit: process.env.PACKAGER_SOURCE_SHA ?? null, workflowCommit: process.env.GITHUB_SHA ?? null, repository: process.env.GITHUB_REPOSITORY ?? null, runId: process.env.GITHUB_RUN_ID ?? null, signing: 'unsigned / macOS ad-hoc only; not notarized', generatedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch }, toolchain: TOOLCHAIN, artifacts }, null, 2) + '\n');
  return artifacts;
}

export async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_WORKSPACE || !process.env.RUNNER_TEMP) throw new Error('为避免在本机执行陌生仓库代码，此脚本只允许在 GitHub Actions runner 中运行。');
  const workspace = await fsp.realpath(process.env.GITHUB_WORKSPACE);
  const runnerTemp = await fsp.realpath(process.env.RUNNER_TEMP);
  if (isWithin(workspace, runnerTemp) || isWithin(runnerTemp, workspace)) throw new Error('runner 临时目录和源码目录必须相互隔离。');
  if (!/^[a-f0-9]{40}$/iu.test(process.env.PACKAGER_SOURCE_SHA ?? '')) throw new Error('source_sha 必须是已审核的完整 40 位提交标识。');
  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, env: cleanEnvironment(), shell: false, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 }).trim();
  if (actualSha.toLowerCase() !== process.env.PACKAGER_SOURCE_SHA.toLowerCase()) throw new Error('实际检出的源码与已审核提交不一致，已停止执行构建脚本。');
  const configPath = await resolveContained(workspace, '.github/packager/config.json', '打包配置');
  const config = normalizeConfig(await readJson(configPath));
  const target = process.env.PACKAGER_TARGET;
  if (!config.targets.includes(target)) throw new Error('构建目标不在已审核配置中。');
  if (TARGETS[target].platform !== process.platform || TARGETS[target].arch !== process.arch) throw new Error(`runner 架构不匹配：需要 ${TARGETS[target].platform}/${TARGETS[target].arch}，实际 ${process.platform}/${process.arch}。`);
  const project = await resolveContained(workspace, config.projectDir, '项目目录');
  if (!(await fsp.stat(project)).isDirectory()) throw new Error('项目目录不是文件夹。');
  const scratch = await fsp.mkdtemp(path.join(runnerTemp, 'github-packager-'));
  const output = path.join(scratch, 'installers');
  const artifactBase = path.join(runnerTemp, 'packager-artifacts');
  // No deletion of repository-controlled paths. Fresh jobs must have a fresh artifact directory.
  await fsp.mkdir(artifactBase);
  const destination = path.join(artifactBase, target);
  console.log(`[packager] ${config.appName} ${config.version} / ${target}; 来源 ${process.env.PACKAGER_SOURCE_SHA}`);
  if (config.kind === 'electron') await buildElectron(project, config, target, output);
  else if (config.kind === 'web') await buildWeb(project, config, target, scratch, output);
  else await buildPython(project, config, target, scratch, output);
  const artifacts = await collectArtifacts(output, destination, config, target);
  console.log(`[packager] 完成：${artifacts.map(item => item.filename).join(', ')}`);
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[packager] ${error.message}`); process.exitCode = 1; });
}
