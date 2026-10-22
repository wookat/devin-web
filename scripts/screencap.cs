// screencap — capture the virtual screen (all monitors) in a loop and write
// [uint32le length][jpeg bytes]* frames to stdout. Compiled once at runtime
// by server/src/screen.ts via the in-box .NET Framework csc.exe.
// Args: <maxWidth> <jpegQuality> <delayMs> [monitor: virtual|primary]
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class ScreenCap
{
    static int Main(string[] args)
    {
        int maxWidth = args.Length > 0 ? int.Parse(args[0]) : 1600;
        long quality = args.Length > 1 ? long.Parse(args[1]) : 55;
        int delay = args.Length > 2 ? int.Parse(args[2]) : 250;
        string monitor = args.Length > 3 ? args[3] : "primary";

        Rectangle vs = monitor == "virtual" ? SystemInformation.VirtualScreen : Screen.PrimaryScreen.Bounds;
        int w = vs.Width, h = vs.Height;
        double scale = Math.Min(1.0, (double)maxWidth / w);
        int sw = Math.Max(1, (int)(w * scale)), sh = Math.Max(1, (int)(h * scale));

        var full = new Bitmap(w, h);
        var gf = Graphics.FromImage(full);
        var bmp = new Bitmap(sw, sh);
        var g = Graphics.FromImage(bmp);
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;

        ImageCodecInfo jpeg = null;
        foreach (var e in ImageCodecInfo.GetImageEncoders())
            if (e.MimeType == "image/jpeg") jpeg = e;
        if (jpeg == null) return 2;
        var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(Encoder.Quality, quality);

        Stream stdout = Console.OpenStandardOutput();
        while (true)
        {
            try
            {
                gf.CopyFromScreen(vs.Left, vs.Top, 0, 0, full.Size);
                g.DrawImage(full, 0, 0, sw, sh);
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, jpeg, ep);
                    byte[] bytes = ms.ToArray();
                    stdout.Write(BitConverter.GetBytes(bytes.Length), 0, 4);
                    stdout.Write(bytes, 0, bytes.Length);
                    stdout.Flush();
                }
            }
            catch { /* locked workstation / transient GDI failure — keep looping */ }
            Thread.Sleep(delay);
        }
    }
}
