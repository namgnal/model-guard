$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$guardAssets = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets'
[IO.Directory]::CreateDirectory($guardAssets) | Out-Null
$guardImages = @()
foreach ($guardSize in @(16, 24, 32, 48, 64, 128, 256)) {
    $guardBitmap = [Drawing.Bitmap]::new($guardSize, $guardSize)
    $guardGraphics = [Drawing.Graphics]::FromImage($guardBitmap)
    $guardGraphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $guardGraphics.ScaleTransform($guardSize / 256.0, $guardSize / 256.0)
    $guardShape = [Drawing.Drawing2D.GraphicsPath]::new()
    $guardShape.AddArc(8, 8, 88, 88, 180, 90)
    $guardShape.AddArc(160, 8, 88, 88, 270, 90)
    $guardShape.AddArc(160, 160, 88, 88, 0, 90)
    $guardShape.AddArc(8, 160, 88, 88, 90, 90)
    $guardShape.CloseFigure()
    $guardBrush = [Drawing.Drawing2D.LinearGradientBrush]::new([Drawing.Point]::new(16, 16), [Drawing.Point]::new(240, 240), [Drawing.ColorTranslator]::FromHtml('#3376e7'), [Drawing.ColorTranslator]::FromHtml('#183f99'))
    $guardGraphics.FillPath($guardBrush, $guardShape)
    $guardPen = [Drawing.Pen]::new([Drawing.Color]::White, 14)
    $guardGraphics.DrawEllipse($guardPen, 59, 59, 138, 138)
    $guardGraphics.DrawEllipse($guardPen, 99, 99, 58, 58)
    $guardMemory = [IO.MemoryStream]::new()
    $guardBitmap.Save($guardMemory, [Drawing.Imaging.ImageFormat]::Png)
    $guardImages += ,@{Size = $guardSize; Bytes = $guardMemory.ToArray()}
    if ($guardSize -eq 256) { $guardBitmap.Save((Join-Path $guardAssets 'icon.png'), [Drawing.Imaging.ImageFormat]::Png) }
    $guardMemory.Dispose(); $guardPen.Dispose(); $guardBrush.Dispose(); $guardShape.Dispose(); $guardGraphics.Dispose(); $guardBitmap.Dispose()
}
$guardStream = [IO.File]::Create((Join-Path $guardAssets 'icon.ico'))
$guardWriter = [IO.BinaryWriter]::new($guardStream)
try {
    $guardWriter.Write([UInt16]0); $guardWriter.Write([UInt16]1); $guardWriter.Write([UInt16]$guardImages.Count)
    $guardOffset = 6 + 16 * $guardImages.Count
    foreach ($guardItem in $guardImages) {
        $guardDimension = if ($guardItem.Size -eq 256) { 0 } else { $guardItem.Size }
        $guardWriter.Write([Byte]$guardDimension); $guardWriter.Write([Byte]$guardDimension)
        $guardWriter.Write([Byte]0); $guardWriter.Write([Byte]0)
        $guardWriter.Write([UInt16]1); $guardWriter.Write([UInt16]32)
        $guardWriter.Write([UInt32]$guardItem.Bytes.Length); $guardWriter.Write([UInt32]$guardOffset)
        $guardOffset += $guardItem.Bytes.Length
    }
    foreach ($guardItem in $guardImages) { $guardWriter.Write([Byte[]]$guardItem.Bytes) }
} finally { $guardWriter.Dispose(); $guardStream.Dispose() }
