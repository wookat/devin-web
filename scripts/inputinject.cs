// inputinject — persistent input-injection helper for the web live view.
// Reads one command per line from stdin and injects via SendInput:
//   m <u> <v>            move pointer to normalized virtual-screen coords
//   d <l|r|m>            mouse button down
//   u <l|r|m>            mouse button up
//   w <deltaPixels>      vertical wheel (pixels, sign = direction)
//   k <vk> down|up       virtual-key down/up (rawKeyDown/keyUp chords)
//   t <base64-utf8>      type text (unicode chars via KEYEVENTF_UNICODE)
// Coordinates are normalized 0..1 over SystemInformation.VirtualScreen —
// the same rectangle screencap.cs captures, so no client-side DPI math.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

static class InputInject
{
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint n, INPUT[] inputs, int cbSize);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }

    static int Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        var stdin = Console.In;
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            try { Run(line); } catch { /* keep the loop alive */ }
        }
        return 0;
    }

    static void Run(string line)
    {
        var p = line.Split(' ');
        switch (p[0])
        {
            case "m":
            {
                // u/v are normalized over the CAPTURED rect (primary monitor by
                // default — matching screencap), but VIRTUALDESK absolute input
                // space spans the whole virtual screen. Convert: capture-rect
                // pixel → virtual-screen pixel → 0..65535.
                var vsAll = SystemInformation.VirtualScreen;
                Rectangle rc = p.Length > 3 && p[3] == "virtual" ? vsAll : Screen.PrimaryScreen.Bounds;
                double u2 = double.Parse(p[1], System.Globalization.CultureInfo.InvariantCulture);
                double v2 = double.Parse(p[2], System.Globalization.CultureInfo.InvariantCulture);
                double px = rc.Left + u2 * rc.Width;
                double py = rc.Top + v2 * rc.Height;
                Send(new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT {
                    dx = (int)((px - vsAll.Left) / vsAll.Width * 65535.0),
                    dy = (int)((py - vsAll.Top) / vsAll.Height * 65535.0),
                    dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK } } });
                break;
            }
            case "d": case "u":
            {
                uint flag = BtnFlag(p[1], p[0] == "d");
                if (flag != 0)
                    Send(new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = flag } } });
                break;
            }
            case "w":
            {
                int px = int.Parse(p[1], System.Globalization.CultureInfo.InvariantCulture);
                int steps = Math.Max(-10, Math.Min(10, px / 40)); // ~40px per notch
                if (steps != 0)
                    Send(new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { mouseData = (uint)(steps * 120), dwFlags = MOUSEEVENTF_WHEEL } } });
                break;
            }
            case "k":
            {
                ushort vk = ushort.Parse(p[1], System.Globalization.CultureInfo.InvariantCulture);
                Send(new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT {
                    wVk = vk, dwFlags = p[2] == "up" ? KEYEVENTF_KEYUP : 0 } } });
                break;
            }
            case "t":
            {
                var text = Encoding.UTF8.GetString(Convert.FromBase64String(p[1]));
                foreach (var ch in text)
                {
                    Send(new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = ch, dwFlags = KEYEVENTF_UNICODE } } });
                    Send(new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = ch, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } });
                }
                break;
            }
        }
    }

    static uint BtnFlag(string b, bool down)
    {
        switch (b)
        {
            case "l": return down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
            case "r": return down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
            case "m": return down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
            default: return 0;
        }
    }
}
