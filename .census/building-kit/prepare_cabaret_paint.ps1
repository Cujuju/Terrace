$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$paintRoot = Join-Path $PSScriptRoot 'cabaret-paint'
New-Item -ItemType Directory -Force -Path $paintRoot | Out-Null
$gold = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(204,161,88))
$red = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(157,30,47))
$cream = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(215,190,137))
$ink = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(92,24,32))
$pen = [System.Drawing.Pen]::new($gold,7)
$fine = [System.Drawing.Pen]::new($ink,5)
function Paint-Text($graphics,$text,$size,$top,$brush,$width) {
    $font = [System.Drawing.Font]::new('Georgia',$size,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Pixel)
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString($text,$font,$brush,[System.Drawing.RectangleF]::new(0,$top,$width,180),$format)
    $format.Dispose(); $font.Dispose()
}
foreach ($name in @('front','side','awning')) {
    $width = 1200; $height = if ($name -eq 'front') { 900 } elseif ($name -eq 'side') { 400 } else { 250 }
    $bitmap = [System.Drawing.Bitmap]::new($width,$height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear([System.Drawing.Color]::FromArgb(92,24,32))
    if ($name -eq 'front') {
        $graphics.DrawRectangle($pen,25,25,1150,850)
        # Original hand-drawn adult cabaret silhouette; no concept pixels used.
        $points = @(@(380,455),@(402,406),@(425,364),@(435,310),@(454,270),@(455,222),@(440,191),@(447,150),@(470,117),@(505,105),@(539,122),@(553,149),@(550,175),@(570,187),@(557,201),@(550,229),@(534,240),@(530,259),@(552,278),@(574,314),@(603,337),@(658,290),@(698,272),@(715,284),@(688,298),@(685,321),@(675,325),@(665,303),@(610,379),@(586,383),@(555,362),@(551,400),@(573,432),@(639,455),@(714,366),@(742,345),@(772,360),@(817,425),@(861,489),@(910,507),@(946,537),@(942,551),@(896,545),@(870,541),@(813,479),@(751,420),@(718,476),@(697,522),@(722,564),@(768,598),@(808,604),@(851,631),@(854,644),@(808,641),@(763,630),@(688,592),@(634,557),@(593,537),@(536,530),@(492,507),@(456,474),@(438,482),@(397,484),@(346,499),@(312,502),@(292,492),@(323,480),@(364,466))
        $shape = [System.Drawing.PointF[]]@($points | ForEach-Object { [System.Drawing.PointF]::new($_[0],$_[1]) })
        $graphics.FillPolygon($gold,$shape)
        # Fan radiates from the raised hand, a simple painted emblem.
        foreach ($angle in @(-75,-52,-28,-4,20,44)) {
            $graphics.TranslateTransform(698,281); $graphics.RotateTransform($angle)
            $graphics.FillEllipse($red,-22,-208,44,212)
            $graphics.DrawLine($fine,0,-195,0,-5)
            $graphics.ResetTransform()
        }
        # Broad corset edge and stocking bands survive atlas reduction.
        $graphics.DrawBezier($fine,464,320,510,294,536,319,550,365)
        $graphics.DrawBezier($fine,464,320,471,370,477,407,489,447)
        $graphics.DrawBezier($fine,550,365,520,389,527,425,533,460)
        $graphics.DrawLine($fine,491,343,521,439)
        $graphics.DrawLine($fine,712,403,751,433)
        $graphics.DrawLine($fine,680,548,697,524)
        Paint-Text $graphics "DURAND'S" 139 672 $gold $width
    } elseif ($name -eq 'side') {
        $graphics.DrawRectangle($pen,35,35,1130,330)
        Paint-Text $graphics "DURAND'S" 174 93 $gold $width
    } else {
        $graphics.DrawLine($pen,25,60,1175,60)
        $graphics.DrawLine($pen,25,205,1175,205)
    }
    $bitmap.Save((Join-Path $paintRoot ($name+'.png')),[System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
}
$gold.Dispose();$red.Dispose();$cream.Dispose();$ink.Dispose();$pen.Dispose();$fine.Dispose()
