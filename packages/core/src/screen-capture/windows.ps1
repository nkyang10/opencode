param($p)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class OpenCodeCaptureException : Exception
{
    public string Code;
    public string[] Candidates;

    public OpenCodeCaptureException(string code, string message, string[] candidates) : base(message)
    {
        Code = code;
        Candidates = candidates == null ? new string[0] : candidates;
    }
}

public static class OpenCodeScreenCapture
{
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const int DWMWA_CLOAKED = 14;
    const int SW_RESTORE = 9;
    const int SW_MINIMIZE = 6;
    const uint PW_RENDERFULLCONTENT = 0x00000002;
    const uint MONITOR_DEFAULTTONEAREST = 0x00000002;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public int Width
        {
            get { return Right - Left; }
        }

        public int Height
        {
            get { return Bottom - Top; }
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    public class MonitorRecord
    {
        public IntPtr Handle;
        public RECT Bounds;
        public string Device;
        public bool Primary;
    }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    delegate bool EnumDisplayMonitorsProc(IntPtr hMonitor, IntPtr hdc, ref RECT pRect, IntPtr data);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
    static extern IntPtr GetWindowLong32(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
    static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumDisplayMonitorsProc callback, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpMonitorInfo);

    [DllImport("user32.dll")]
    static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    [DllImport("user32.dll")]
    static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);

    public static void EnableDpi()
    {
        try { SetProcessDPIAware(); } catch { }
    }

    public static object List()
    {
        var monitors = Monitors();
        var displays = new List<object>();
        for (int i = 0; i < monitors.Count; i++)
        {
            var monitor = monitors[i];
            displays.Add(new Dictionary<string, object>
            {
                { "index", i + 1 },
                { "name", MonitorName(monitor.Device) },
                { "primary", monitor.Primary },
                { "bounds", BoundsDictionary(monitor.Bounds) }
            });
        }

        var foreground = GetForegroundWindow();
        return new Dictionary<string, object>
        {
            { "displays", displays.ToArray() },
            { "windows", Windows(monitors).ToArray() },
            { "active", foreground == IntPtr.Zero ? null : HandleToId(foreground) }
        };
    }

    public static object Capture(string target, string id, string window, bool restoreMinimized, string display)
    {
        if (string.Equals(target, "window", StringComparison.OrdinalIgnoreCase))
            return CaptureWindow(id, restoreMinimized);
        return CaptureScreen(display);
    }

    static List<MonitorRecord> Monitors()
    {
        var monitors = new List<MonitorRecord>();
        EnumDisplayMonitorsProc callback = delegate(IntPtr hMonitor, IntPtr hdc, ref RECT pRect, IntPtr data)
        {
            var info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(hMonitor, ref info))
            {
                monitors.Add(new MonitorRecord
                {
                    Handle = hMonitor,
                    Bounds = info.rcMonitor,
                    Device = info.szDevice,
                    Primary = (info.dwFlags & 1) != 0
                });
            }
            return true;
        };

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
        int primary = monitors.FindIndex(delegate(MonitorRecord monitor) { return monitor.Primary; });
        if (primary < 0 && monitors.Count > 0)
        {
            monitors[0].Primary = true;
        }
        return monitors;
    }

    static List<Dictionary<string, object>> Windows(List<MonitorRecord> monitors)
    {
        var windows = new List<Dictionary<string, object>>();
        EnumWindowsProc callback = delegate(IntPtr hWnd, IntPtr lParam)
        {
            AddWindow(hWnd, monitors, windows);
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        return windows;
    }

    static void AddWindow(IntPtr hWnd, List<MonitorRecord> monitors, List<Dictionary<string, object>> windows)
    {
        try
        {
            if (!IsWindowVisible(hWnd) || IsCloaked(hWnd) || !IsWindow(hWnd)) return;
            var title = WindowText(hWnd);
            if (string.IsNullOrWhiteSpace(title)) return;

            var exStyle = GetWindowLongValue(hWnd, GWL_EXSTYLE);
            if ((exStyle & WS_EX_TOOLWINDOW) != 0) return;

            RECT bounds;
            if (!TryWindowBounds(hWnd, out bounds) || bounds.Width <= 0 || bounds.Height <= 0) return;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            var processName = ProcessName(pid);
            var display = MonitorIndex(monitors, MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST));
            var entry = new Dictionary<string, object>
            {
                { "id", HandleToId(hWnd) },
                { "title", title },
                { "bounds", BoundsDictionary(bounds) },
                { "minimized", IsIconic(hWnd) },
                { "currentDesktop", true }
            };
            if (!string.IsNullOrEmpty(processName)) entry["app"] = processName;
            if (display > 0) entry["display"] = display;
            if (pid > 0) entry["pid"] = (int)pid;
            windows.Add(entry);
        }
        catch
        {
        }
    }

    static object CaptureScreen(string display)
    {
        var monitors = Monitors();
        if (monitors.Count == 0)
            throw new OpenCodeCaptureException("no_display", "no Windows monitors were detected", new string[0]);

        var selected = new List<MonitorRecord>();
        string outputDisplay = "primary";
        if (string.IsNullOrEmpty(display) || string.Equals(display.Trim(), "primary", StringComparison.OrdinalIgnoreCase))
        {
            int primary = monitors.FindIndex(delegate(MonitorRecord monitor) { return monitor.Primary; });
            if (primary < 0) primary = 0;
            selected.Add(monitors[primary]);
            outputDisplay = (primary + 1).ToString();
        }
        else if (string.Equals(display.Trim(), "all", StringComparison.OrdinalIgnoreCase))
        {
            selected.AddRange(monitors);
            outputDisplay = "all";
        }
        else
        {
            int parsed;
            if (!int.TryParse(display.Trim(), out parsed) || parsed < 1 || parsed > monitors.Count)
                throw new OpenCodeCaptureException("unsupported", "display " + display + " was not found", new string[0]);
            selected.Add(monitors[parsed - 1]);
            outputDisplay = parsed.ToString();
        }

        int left = int.MaxValue;
        int top = int.MaxValue;
        int right = int.MinValue;
        int bottom = int.MinValue;
        foreach (var monitor in selected)
        {
            left = Math.Min(left, monitor.Bounds.Left);
            top = Math.Min(top, monitor.Bounds.Top);
            right = Math.Max(right, monitor.Bounds.Right);
            bottom = Math.Max(bottom, monitor.Bounds.Bottom);
        }

        int width = right - left;
        int height = bottom - top;
        if (width <= 0 || height <= 0)
            throw new OpenCodeCaptureException("no_display", "the selected display has no visible bounds", new string[0]);

        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            try
            {
                using (var graphics = Graphics.FromImage(bitmap))
                {
                    graphics.CopyFromScreen(left, top, 0, 0, new Size(width, height));
                }
            }
            catch (Exception ex)
            {
                throw new OpenCodeCaptureException("permission_required", "CopyFromScreen failed: " + ex.Message, new string[0]);
            }

            var result = BitmapResult(bitmap, "screen");
            result["display"] = outputDisplay;
            return result;
        }
    }

    static object CaptureWindow(string id, bool restoreMinimized)
    {
        if (string.IsNullOrWhiteSpace(id))
            throw new OpenCodeCaptureException("window_not_found", "a window id is required", new string[0]);

        IntPtr hWnd;
        try
        {
            hWnd = ParseHandle(id);
        }
        catch
        {
            throw new OpenCodeCaptureException("window_not_found", "invalid window id: " + id, new string[0]);
        }

        if (!IsWindow(hWnd))
            throw new OpenCodeCaptureException("window_not_found", "the window is no longer available", new string[0]);

        bool wasMinimized = IsIconic(hWnd);
        if (wasMinimized && !restoreMinimized)
            throw new OpenCodeCaptureException("window_not_capturable", "window is minimized and restore_minimized is false", new string[0]);

        var foreground = GetForegroundWindow();
        if (wasMinimized)
        {
            ShowWindow(hWnd, SW_RESTORE);
            Thread.Sleep(50);
            if (IsIconic(hWnd))
                throw new OpenCodeCaptureException("window_not_capturable", "the window could not be restored for capture", new string[0]);
        }

        Bitmap bitmap;
        try
        {
            bitmap = CaptureWindowBitmap(hWnd);
        }
        finally
        {
            if (wasMinimized)
            {
                try { ShowWindow(hWnd, SW_MINIMIZE); } catch { }
                if (foreground != IntPtr.Zero && foreground != hWnd && !IsIconic(foreground))
                {
                    try { SetForegroundWindow(foreground); } catch { }
                }
            }
        }

        using (bitmap)
        {
            var monitors = Monitors();
            var window = WindowDictionary(hWnd, monitors);
            var result = BitmapResult(bitmap, "window");
            result["display"] = window.ContainsKey("display") ? window["display"] : null;
            result["window"] = window;
            result["restored"] = wasMinimized;
            result["focusChanged"] = wasMinimized && foreground != IntPtr.Zero && foreground != hWnd;
            return result;
        }
    }

    static Bitmap CaptureWindowBitmap(IntPtr hWnd)
    {
        RECT bounds;
        if (!GetWindowRect(hWnd, out bounds) || bounds.Width <= 0 || bounds.Height <= 0)
            throw new OpenCodeCaptureException("window_not_capturable", "the window has no capturable bounds", new string[0]);

        var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        try
        {
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.Clear(Color.Black);
                bool printed = false;
                IntPtr hdc = IntPtr.Zero;
                try
                {
                    hdc = graphics.GetHdc();
                    printed = PrintWindow(hWnd, hdc, PW_RENDERFULLCONTENT);
                }
                catch
                {
                }
                finally
                {
                    if (hdc != IntPtr.Zero)
                    {
                        try { graphics.ReleaseHdc(hdc); } catch { }
                    }
                }

                if (!printed)
                    throw new OpenCodeCaptureException("window_not_capturable", "PrintWindow failed for the target window", new string[0]);
            }
            return bitmap;
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }
    }

    static Dictionary<string, object> BitmapResult(Bitmap bitmap, string target)
    {
        byte[] bytes;
        using (var stream = new MemoryStream())
        {
            bitmap.Save(stream, ImageFormat.Png);
            bytes = stream.ToArray();
        }

        return new Dictionary<string, object>
        {
            { "data", Convert.ToBase64String(bytes) },
            { "mime", "image/png" },
            { "width", bitmap.Width },
            { "height", bitmap.Height },
            { "target", target }
        };
    }

    static Dictionary<string, object> WindowDictionary(IntPtr hWnd, List<MonitorRecord> monitors)
    {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        var entry = new Dictionary<string, object> { { "id", HandleToId(hWnd) } };

        var title = WindowText(hWnd);
        if (!string.IsNullOrEmpty(title)) entry["title"] = title;
        var processName = ProcessName(pid);
        if (!string.IsNullOrEmpty(processName)) entry["app"] = processName;
        if (pid > 0) entry["pid"] = (int)pid;
        var display = MonitorIndex(monitors, MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST));
        if (display > 0) entry["display"] = display;
        return entry;
    }

    static string WindowText(IntPtr hWnd)
    {
        int length = GetWindowTextLength(hWnd);
        if (length <= 0) return string.Empty;
        var builder = new StringBuilder(length + 1);
        if (GetWindowText(hWnd, builder, builder.Capacity) <= 0) return string.Empty;
        return builder.ToString();
    }

    static bool TryWindowBounds(IntPtr hWnd, out RECT bounds)
    {
        if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out bounds, Marshal.SizeOf(typeof(RECT))) == 0 && bounds.Width > 0 && bounds.Height > 0)
            return true;
        return GetWindowRect(hWnd, out bounds);
    }

    static bool IsCloaked(IntPtr hWnd)
    {
        try
        {
            int cloaked;
            return DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, Marshal.SizeOf(typeof(int))) == 0 && cloaked != 0;
        }
        catch
        {
            return false;
        }
    }

    static long GetWindowLongValue(IntPtr hWnd, int index)
    {
        return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, index).ToInt64() : GetWindowLong32(hWnd, index).ToInt64();
    }

    static string ProcessName(uint pid)
    {
        try
        {
            using (var process = Process.GetProcessById((int)pid))
            {
                return process.ProcessName;
            }
        }
        catch
        {
            return null;
        }
    }

    static int MonitorIndex(List<MonitorRecord> monitors, IntPtr handle)
    {
        if (handle != IntPtr.Zero)
        {
            for (int i = 0; i < monitors.Count; i++)
            {
                if (monitors[i].Handle == handle) return i + 1;
            }
        }

        int primary = monitors.FindIndex(delegate(MonitorRecord monitor) { return monitor.Primary; });
        if (primary >= 0) return primary + 1;
        return monitors.Count > 0 ? 1 : 0;
    }

    static Dictionary<string, object> BoundsDictionary(RECT bounds)
    {
        return new Dictionary<string, object>
        {
            { "width", bounds.Width },
            { "height", bounds.Height },
            { "x", bounds.Left },
            { "y", bounds.Top }
        };
    }

    static string MonitorName(string device)
    {
        if (string.IsNullOrEmpty(device)) return "monitor";
        int index = device.IndexOf("DISPLAY", StringComparison.OrdinalIgnoreCase);
        return index >= 0 ? device.Substring(index) : device;
    }

    static string HandleToId(IntPtr hWnd)
    {
        ulong value = IntPtr.Size == 8 ? (ulong)hWnd.ToInt64() : (ulong)(uint)hWnd.ToInt32();
        return "0x" + value.ToString("x");
    }

    static IntPtr ParseHandle(string id)
    {
        var text = id.Trim();
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) text = text.Substring(2);
        return new IntPtr((long)Convert.ToUInt64(text, 16));
    }
}
'@

if (-not ('OpenCodeScreenCapture' -as [type])) {
    Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Drawing'
}

try {
    [OpenCodeScreenCapture]::EnableDpi()
    if ([string]$p.operation -eq 'list') {
        $result = [OpenCodeScreenCapture]::List()
        [Console]::Out.Write((ConvertTo-Json $result -Compress -Depth 10))
        return
    }

    $result = [OpenCodeScreenCapture]::Capture(
        [string]$p.target,
        [string]$p.id,
        [string]$p.window,
        [bool]$p.restoreMinimized,
        [string]$p.display
    )
    [Console]::Out.Write((ConvertTo-Json $result -Compress -Depth 10))
} catch {
    $exception = $_.Exception
    while ($exception -and -not ($exception.PSObject.Properties.Name -contains 'Code')) {
        $exception = $exception.InnerException
    }

    $code = if ($exception) { [string]$exception.Code } else { 'unsupported' }
    $reason = if ($exception) { [string]$exception.Message } else { $_.Exception.Message }
    $candidates = @()
    if ($exception -and ($exception.PSObject.Properties.Name -contains 'Candidates')) {
        $candidates = @($exception.Candidates)
    }

    [Console]::Error.Write((@{ code = $code; reason = $reason; candidates = $candidates } | ConvertTo-Json -Compress -Depth 3))
    exit 1
}
