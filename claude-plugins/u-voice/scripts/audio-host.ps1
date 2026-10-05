$ErrorActionPreference = 'Stop'
$profilePath = $null
$hostJob = $null
try {
  # Configuration arrives through the parent's pipe, never a command string.
  $config = [Console]::ReadLine() | ConvertFrom-Json
  if (-not $config -or $config.url -notmatch '^http://127\.0\.0\.1:\d+/#token=[a-zA-Z0-9_%.-]+$') { throw 'Invalid audio host address.' }
  $candidates = @($config.browser,
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
  $browser = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
  if (-not $browser) { throw 'Chrome or Edge is required for background voice audio.' }
  $profilePath = Join-Path ([IO.Path]::GetTempPath()) ('uvoice-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($profilePath) | Out-Null
  $browserArgs = @('--headless=new', '--no-first-run', '--no-default-browser-check', '--noerrdialogs',
    '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
    ('--user-data-dir=' + $profilePath))
  if ($config.syntheticWav) {
    $wavePath = Join-Path $profilePath 'synthetic.wav'
    Copy-Item -LiteralPath $config.syntheticWav -Destination $wavePath
    $browserArgs += @('--use-fake-device-for-media-stream', ('--use-file-for-fake-audio-capture=' + $wavePath + '%noloop'))
  }
  $browserArgs += $config.url
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

public sealed class UVoiceJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Id, ThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr job;
  public uint ProcessId { get; private set; }
  static string Quote(string value) {
    var b = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if(c == '\\') { slashes++; continue; }
      if(c == '"') b.Append('\\', slashes*2+1).Append(c);
      else b.Append('\\', slashes).Append(c);
      slashes=0;
    }
    return b.Append('\\', slashes*2).Append('"').ToString();
  }
  public UVoiceJob(string application, string[] args) {
    job = CreateJobObject(IntPtr.Zero, null);
    if(job == IntPtr.Zero) throw new Exception("Could not create audio process job.");
    var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
    if(!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) { Dispose(); throw new Exception("Could not secure audio process cleanup."); }
    var command = new StringBuilder(Quote(application));
    foreach(string arg in args) command.Append(' ').Append(Quote(arg));
    var startup = new Startup(); startup.Size = (uint)Marshal.SizeOf(typeof(Startup)); startup.Flags=1; startup.Show=0;
    ProcessInfo info;
    if(!CreateProcess(application, command, IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, null, ref startup, out info)) { Dispose(); throw new Exception("Could not start the background audio browser."); }
    try {
      if(!AssignProcessToJobObject(job, info.Process)) { TerminateProcess(info.Process, 1); throw new Exception("Could not own the audio browser process."); }
      if(ResumeThread(info.Thread) == 0xffffffff) { TerminateProcess(info.Process, 1); throw new Exception("Could not resume the audio browser."); }
      ProcessId=info.Id;
    } catch { Dispose(); throw; }
    finally { CloseHandle(info.Thread); CloseHandle(info.Process); }
  }
  public void WaitForParent() {
    var input = Task.Run(() => Console.ReadLine());
    while(!input.IsCompleted) {
      Accounting info;
      if(!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) || info.Active == 0) throw new Exception("Background audio browser exited.");
      Thread.Sleep(200);
    }
  }
  public void Dispose() {
    if(job == IntPtr.Zero) return;
    TerminateJobObject(job, 0); CloseHandle(job); job=IntPtr.Zero;
  }
}
'@
  $hostJob = [UVoiceJob]::new($browser, [string[]]$browserArgs)
  [Console]::WriteLine('{"type":"host.ready","hidden":true}')
  $hostJob.WaitForParent()
} catch {
  # Never include a URL, token, browser command line or provider trace.
  [Console]::WriteLine('{"type":"host.error","message":"Could not run background audio. Chrome or Edge and Windows microphone access are required."}')
  exit 1
} finally {
  if ($hostJob) { $hostJob.Dispose() }
  if ($profilePath) {
    for ($attempt=0; $attempt -lt 10; $attempt++) {
      try { if (Test-Path -LiteralPath $profilePath) { Remove-Item -LiteralPath $profilePath -Recurse -Force }; break } catch { Start-Sleep -Milliseconds 100 }
    }
  }
}
