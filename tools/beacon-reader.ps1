# Reads the SignalBeacon strip from the WoW window and prints one JSON line per change
# (plus a heartbeat every second). Uses PrintWindow, so it works while other windows
# cover the game. The bridge starts this; it can also be run by hand to debug.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\beacon-reader.ps1 [-Process WowB] [-IntervalMs 100]
#   ... -ImagePath shot.png      read one saved screenshot instead (used by tests)
param(
  [string]$Process = 'WowB',
  [int]$IntervalMs = 100,
  [string]$ImagePath = ''
)

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;

public static class Beacon {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  const uint PW_CLIENTONLY_RENDERFULL = 3;
  const int SEARCH_W = 400, SEARCH_H = 200;
  static bool dpi;
  static int mx = -1, my = -1; // cached marker position

  static string Fail(string why) { return "{\"ok\":false,\"why\":\"" + why + "\"}"; }

  public static string ReadWindow(IntPtr h) {
    if (!dpi) { SetProcessDPIAware(); dpi = true; }
    if (h == IntPtr.Zero) return Fail("no window");
    if (IsIconic(h)) return Fail("minimized");
    RECT rc; GetClientRect(h, out rc);
    if (rc.R <= 0 || rc.B <= 0) return Fail("no client area");
    // PrintWindow renders the whole client area; only the top-left corner is examined.
    using (var full = new Bitmap(rc.R, rc.B, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(full)) {
        IntPtr hdc = g.GetHdc();
        bool ok = PrintWindow(h, hdc, PW_CLIENTONLY_RENDERFULL);
        g.ReleaseHdc(hdc);
        if (!ok) return Fail("capture failed");
      }
      return ReadBitmap(full);
    }
  }

  public static string ReadFile(string path) {
    mx = -1;
    using (var src = new Bitmap(path))
    using (var bmp = src.Clone(new Rectangle(0, 0, src.Width, src.Height), PixelFormat.Format32bppArgb)) {
      return ReadBitmap(bmp);
    }
  }

  // Ambience: the average color of AMB_SLICES vertical slices of the game view, left to
  // right, between AMB_TOP and AMB_BOTTOM of the height (skips the top edge with the
  // beacon and the bottom where action bars and chat usually sit). Sampled on a sparse
  // grid straight from the locked bitmap, so it costs well under a millisecond.
  const int AMB_SLICES = 4, AMB_COLS = 24, AMB_ROWS = 20;
  const double AMB_TOP = 0.08, AMB_BOTTOM = 0.68;

  static string Ambience(Bitmap full) {
    var data = full.LockBits(new Rectangle(0, 0, full.Width, full.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      var sb = new System.Text.StringBuilder("[");
      int y0 = (int)(full.Height * AMB_TOP), y1 = (int)(full.Height * AMB_BOTTOM);
      int sliceW = full.Width / AMB_SLICES;
      for (int s = 0; s < AMB_SLICES; s++) {
        long r = 0, g = 0, b = 0, n = 0;
        for (int iy = 0; iy < AMB_ROWS; iy++) {
          int y = y0 + (int)((y1 - y0) * (iy + 0.5) / AMB_ROWS);
          for (int ix = 0; ix < AMB_COLS; ix++) {
            int x = s * sliceW + (int)(sliceW * (ix + 0.5) / AMB_COLS);
            int v = Marshal.ReadInt32(data.Scan0, y * data.Stride + x * 4);
            r += (v >> 16) & 255; g += (v >> 8) & 255; b += v & 255; n++;
          }
        }
        if (s > 0) sb.Append(',');
        sb.AppendFormat("\"{0:x2}{1:x2}{2:x2}\"", r / n, g / n, b / n);
      }
      return sb.Append(']').ToString();
    } finally {
      full.UnlockBits(data);
    }
  }

  static string ReadBitmap(Bitmap full) {
    string amb = Ambience(full);
    int w = Math.Min(full.Width, SEARCH_W), ht = Math.Min(full.Height, SEARCH_H);
    var data = full.LockBits(new Rectangle(0, 0, w, ht), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    string json;
    try {
      int stride = data.Stride;
      byte[] px = new byte[stride * ht];
      Marshal.Copy(data.Scan0, px, 0, px.Length);
      json = Decode(px, stride, w, ht);
    } finally {
      full.UnlockBits(data);
    }
    // Ambience is valid even when the strip isn't (Alt+Z hides the UI, not the world).
    return json.Substring(0, json.Length - 1) + ",\"amb\":" + amb + "}";
  }

  static int R(byte[] p, int s, int x, int y) { return p[y * s + x * 4 + 2]; }
  static int G(byte[] p, int s, int x, int y) { return p[y * s + x * 4 + 1]; }
  static int B(byte[] p, int s, int x, int y) { return p[y * s + x * 4]; }
  static bool Hi(int v) { return v > 180; }
  static bool Lo(int v) { return v < 70; }
  static bool IsMag(byte[] p, int s, int x, int y) { return Hi(R(p,s,x,y)) && Lo(G(p,s,x,y)) && Hi(B(p,s,x,y)); }
  static bool IsRed(byte[] p, int s, int x, int y) { return Hi(R(p,s,x,y)) && Lo(G(p,s,x,y)) && Lo(B(p,s,x,y)); }
  static bool IsBlue(byte[] p, int s, int x, int y) { return Lo(R(p,s,x,y)) && Lo(G(p,s,x,y)) && Hi(B(p,s,x,y)); }
  static bool IsYellow(byte[] p, int s, int x, int y) { return Hi(R(p,s,x,y)) && Hi(G(p,s,x,y)) && Lo(B(p,s,x,y)); }
  static bool IsCyan(byte[] p, int s, int x, int y) { return Lo(R(p,s,x,y)) && Hi(G(p,s,x,y)) && Hi(B(p,s,x,y)); }
  static bool IsGreen(byte[] p, int s, int x, int y) { return Lo(R(p,s,x,y)) && Hi(G(p,s,x,y)) && Lo(B(p,s,x,y)); }

  static string Decode(byte[] p, int s, int w, int ht) {
    if (mx < 0 || mx >= w || my >= ht || !IsMag(p, s, mx, my)) {
      mx = -1;
      for (int y = 0; y < ht && mx < 0; y++)
        for (int x = 0; x < w; x++)
          if (IsMag(p, s, x, y)) { mx = x; my = y; break; }
      if (mx < 0) return Fail("no marker");
    }

    // Measure the marker; every block is the same width. Sample the vertical middle.
    int mEnd = mx; while (mEnd + 1 < w && IsMag(p, s, mEnd + 1, my)) mEnd++;
    int mBot = my; while (mBot + 1 < ht && IsMag(p, s, mx, mBot + 1)) mBot++;
    int unit = mEnd - mx + 1;
    int row = (my + mBot) / 2;
    if (unit < 2) return Fail("marker too small");

    int fx = mEnd + 1 + unit / 2;
    if (fx >= w) return Fail("no flags");
    bool dead = R(p,s,fx,row) > 128, combat = G(p,s,fx,row) > 128, enc = B(p,s,fx,row) > 128;

    // Layout v2 has a result block before the bar; v1 (addon 0.1) goes straight to the bar.
    int afterFlags = mEnd + 1 + unit;
    int version = 2, barX = afterFlags + unit;
    if (afterFlags < w && (IsRed(p, s, afterFlags + 1, row) || IsBlue(p, s, afterFlags + 1, row))
        && (IsRed(p, s, afterFlags + unit - 1, row) || IsBlue(p, s, afterFlags + unit - 1, row))) {
      // No result block: the bar starts right after the flags. (Result colors are never red/blue.)
      version = 1; barX = afterFlags;
    }
    bool won = false, wiped = false;
    if (version == 2) {
      int rx = afterFlags + unit / 2;
      int rr = R(p,s,rx,row), rg = G(p,s,rx,row), rb = B(p,s,rx,row);
      won = rg > 128 && rr < 128;
      wiped = rr > 128 && rg > 128 && rb > 128;
    }

    int red = 0, blue = 0, xx = barX;
    while (xx < w && IsRed(p, s, xx, row)) { red++; xx++; }
    while (xx < w && IsBlue(p, s, xx, row)) { blue++; xx++; }
    if (red + blue < 8) return Fail("no bar");

    double hp = (double)red / (red + blue);

    // Layout 3 (addon 0.3) adds a second row: [yellow marker][R=ghost G=has mana][spare][mana: cyan on green].
    bool ghost = false, hasMana = false;
    string mana = "null";
    int rowH = mBot - my + 1;
    int row2 = mBot + 1 + rowH / 2;
    if (version == 2 && row2 < ht && IsYellow(p, s, mx + unit / 2, row2)) {
      version = 3;
      ghost = R(p,s,fx,row2) > 128;
      hasMana = G(p,s,fx,row2) > 128;
      int cyan = 0, green = 0, mxx = barX;
      while (mxx < w && IsCyan(p, s, mxx, row2)) { cyan++; mxx++; }
      while (mxx < w && IsGreen(p, s, mxx, row2)) { green++; mxx++; }
      if (hasMana && cyan + green >= 8) mana = ((double)cyan / (cyan + green)).ToString("F3", CultureInfo.InvariantCulture);
    }

    return String.Format(CultureInfo.InvariantCulture,
      "{{\"ok\":true,\"hp\":{0:F3},\"dead\":{1},\"ghost\":{2},\"combat\":{3},\"encounter\":{4},\"won\":{5},\"wiped\":{6},\"hasMana\":{7},\"mana\":{8},\"layout\":{9},\"barPx\":{10}}}",
      hp, J(dead), J(ghost), J(combat), J(enc), J(won), J(wiped), J(hasMana), mana, version, red + blue);
  }

  static string J(bool b) { return b ? "true" : "false"; }
}
'@

if ($ImagePath) {
  [Console]::Out.WriteLine([Beacon]::ReadFile((Resolve-Path $ImagePath).Path))
  exit 0
}

$last = $null
$lastPrint = [DateTime]::MinValue
$hwnd = [IntPtr]::Zero
$procId = 0
while ($true) {
  if ($hwnd -eq [IntPtr]::Zero -or -not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
    $p = Get-Process -Name $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { $hwnd = $p.MainWindowHandle; $procId = $p.Id } else { $hwnd = [IntPtr]::Zero; $procId = 0 }
  }
  try { $line = [Beacon]::ReadWindow($hwnd) } catch { $line = '{"ok":false,"why":"error"}' }
  $now = [DateTime]::UtcNow
  if ($line -ne $last -or ($now - $lastPrint).TotalMilliseconds -ge 1000) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
    $last = $line
    $lastPrint = $now
  }
  Start-Sleep -Milliseconds $IntervalMs
}
