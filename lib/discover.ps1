# dsh-workbuddy endpoint discovery
# Finds the WorkBuddy codebuddy gateways: reads CODEBUDDY_GATEWAY_PASSWORD from the
# process environment and pairs it with that process's listening port.
# Covers both `--prewarm` (idle pool) and `--serve --session-id` (the one that
# actually serves a running task). Output: one line of JSON. ASCII only.

$ErrorActionPreference = 'Continue'

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WbDiscEnv {
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int len, out int ret);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    static byte[] ReadBytes(IntPtr h, IntPtr addr, int size, out int got) {
        byte[] buf = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(h, addr, buf, size, out read)) { got = 0; return null; }
        got = (int)read;
        return buf;
    }

    public static string GetEnv(int pid) {
        IntPtr h = OpenProcess(0x0400 | 0x0010, false, pid);
        if (h == IntPtr.Zero) return "ERR:open:" + Marshal.GetLastWin32Error();
        try {
            PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
            int ret;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return "ERR:query";
            int got;
            byte[] pp = ReadBytes(h, pbi.PebBaseAddress + 0x20, 8, out got);
            if (pp == null) return "ERR:peb";
            IntPtr procParams = (IntPtr)BitConverter.ToInt64(pp, 0);
            byte[] envPtr = ReadBytes(h, procParams + 0x80, 8, out got);
            if (envPtr == null) return "ERR:param";
            IntPtr envAddr = (IntPtr)BitConverter.ToInt64(envPtr, 0);
            long envSize = 65536;
            byte[] sizeBuf = ReadBytes(h, procParams + 0x3F0, 8, out got);
            if (sizeBuf != null) {
                long s = BitConverter.ToInt64(sizeBuf, 0);
                if (s > 0 && s < 1048576) envSize = s;
            }
            byte[] env = ReadBytes(h, envAddr, (int)envSize, out got);
            if (env == null) return "ERR:envpmem";
            return Encoding.Unicode.GetString(env, 0, got);
        } finally { CloseHandle(h); }
    }
}
'@

$typeReady = $false
try {
    if (-not ('WbDiscEnv' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop }
    $typeReady = $true
} catch {
    $typeReady = $false
    $typeError = $_.Exception.Message
}

$result = [ordered]@{
    ok         = $false
    reason     = 'workbuddy-not-running'
    candidates = @()
    debug      = [ordered]@{ pids = @(); envOk = 0; pwdOk = 0; portOk = 0; typeReady = $false }
}
if (-not $typeReady -and $typeError) { $result.debug.typeError = $typeError }
$result.debug.typeReady = $typeReady

$procs = @(Get-CimInstance Win32_Process -Filter "Name='WorkBuddy.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'codebuddy' })
$result.debug.pids = @($procs | ForEach-Object { [int]$_.ProcessId })

$candidates = @()
foreach ($p in $procs) {
    $pidNum = [int]$p.ProcessId
    if (-not $typeReady) { break }
    $envText = [WbDiscEnv]::GetEnv($pidNum)
    if (-not $envText -or $envText.StartsWith('ERR:')) {
        if ($envText) { $result.debug['envError_' + $pidNum] = $envText }
        continue
    }
    $result.debug.envOk++

    $password = $null
    $configDir = $null
    foreach ($line in ($envText -split ([char]0))) {
        if ($line -like 'CODEBUDDY_GATEWAY_PASSWORD=*') { $password = $line -replace '^CODEBUDDY_GATEWAY_PASSWORD=', '' }
        elseif ($line -like 'CODEBUDDY_CONFIG_DIR=*') { $configDir = $line -replace '^CODEBUDDY_CONFIG_DIR=', '' }
    }
    if (-not $password) { continue }
    $result.debug.pwdOk++

    $ports = @()
    foreach ($c in (Get-NetTCPConnection -State Listen -OwningProcess $pidNum -ErrorAction SilentlyContinue)) {
        if ($c.LocalAddress -eq '127.0.0.1' -or $c.LocalAddress -eq '::1' -or $c.LocalAddress -eq '0.0.0.0') {
            $ports += [int]$c.LocalPort
        }
    }
    if ($ports.Count -gt 0) { $result.debug.portOk++ }

    $candidates += [ordered]@{
        pid      = $pidNum
        password = $password
        configDir = $configDir
        ports    = @($ports | Sort-Object -Unique)
    }
}

if ($candidates.Count -gt 0) {
    $result.ok = $true
    $result.reason = 'ok'
    $result.candidates = $candidates
} else {
    $anyApp = @(Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue)
    if ($anyApp.Count -gt 0) { $result.reason = 'prewarm-credentials-unavailable' }
}

($result | ConvertTo-Json -Depth 6 -Compress)
