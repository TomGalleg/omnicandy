var R = "E:/ClaudeCraft/CreateCraft_7_App_Integration_Test/";
var p = app.project;
var W = 1920, H = 1080, FPS = 30, DUR = 6;
var c = p.items.addComp("VOLTERRA X1 Logo Reveal", W, H, 1, DUR, FPS);
var seed = 7; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
var bg = c.layers.addSolid([0.008, 0.012, 0.04], "Background", W, H, 1);
// soft central glow plate
var plate = c.layers.addSolid([0.05, 0.25, 0.7], "Blue plate", W, H, 1);
plate.property("Transform").property("Opacity").setValue(18);
var fp = plate.property("Effects").addProperty("ADBE Gaussian Blur 2");
// particles
function rectLayer(name, w, h, col, x, y) {
  var L = c.layers.addShape(); L.name = name;
  var g = L.property("Contents").addProperty("ADBE Vector Group");
  var r = g.property("Contents").addProperty("ADBE Vector Shape - Rect");
  r.property("Size").setValue([w, h]);
  var f = g.property("Contents").addProperty("ADBE Vector Graphic - Fill");
  f.property("Color").setValue(col);
  L.property("Transform").property("Position").setValue([x, y]);
  return L;
}
for (var i = 0; i < 40; i++) {
  var x = 100 + rnd() * 1720, y = 700 + rnd() * 450, s = 3 + rnd() * 5;
  var L = rectLayer("Particle " + (i + 1), s, s, [0.5, 0.85, 1], x, y);
  var pos = L.property("Transform").property("Position");
  pos.setValueAtTime(0, [x, y]); pos.setValueAtTime(DUR, [x + (rnd() - 0.5) * 160, y - 350 - rnd() * 250]);
  var op = L.property("Transform").property("Opacity");
  op.setValueAtTime(0, 0); op.setValueAtTime(0.5 + rnd(), 25 + rnd() * 45); op.setValueAtTime(DUR - 0.5, 20); op.setValueAtTime(DUR, 0);
}
// logo
var io = new ImportOptions(new File(R + "VectorCraft/volterra-x1-logo-transparent.png"));
var item = p.importFile(io);
var logo = c.layers.add(item);
logo.name = "VOLTERRA X1 logo";
var tr = logo.property("Transform");
tr.property("Position").setValue([W / 2, H / 2 - 60]);
var sc = tr.property("Scale"); sc.setValueAtTime(0.4, [72, 72]); sc.setValueAtTime(2.6, [100, 100]);
var lo = tr.property("Opacity"); lo.setValueAtTime(0.9, 0); lo.setValueAtTime(1.9, 100);
var gl = logo.property("Effects").addProperty("ADBE Glo2");
// light streaks sweeping across (delayed starts)
var ys = [330, 420, 520, 610, 700, 480];
for (var k = 0; k < ys.length; k++) {
  var S = rectLayer("Light streak " + (k + 1), 900, 5 + (k % 3) * 2, [0.2, 0.75, 1], 0, ys[k]);
  var sp = S.property("Transform").property("Position");
  var t0 = 0.2 + k * 0.28;
  sp.setValueAtTime(t0, [-700, ys[k]]); sp.setValueAtTime(t0 + 1.3, [W + 700, ys[k]]);
  var so = S.property("Transform").property("Opacity");
  so.setValueAtTime(0, 0); so.setValueAtTime(t0, 0); so.setValueAtTime(t0 + 0.15, 100); so.setValueAtTime(t0 + 1.2, 100); so.setValueAtTime(t0 + 1.3, 0);
  var sg = S.property("Effects").addProperty("ADBE Glo2");
}
// tagline
var tx = c.layers.addText("THE FUTURE HAS ARRIVED.");
tx.name = "Tagline";
var tp = tx.property("Source Text"); var td = tp.value;
td.fontSize = 62; td.fillColor = [0.91, 0.96, 1]; td.justification = ParagraphJustification.CENTER_JUSTIFY;
try { td.font = "Arial-BoldMT"; } catch (e) {}
tp.setValue(td);
tx.property("Transform").property("Position").setValue([W / 2, 880]);
var to = tx.property("Transform").property("Opacity"); to.setValueAtTime(3.2, 0); to.setValueAtTime(4.2, 100);
writeLn("layers=" + c.numLayers + " logo=" + item.width + "x" + item.height);
p.save(new File(R + "EffectCraft/volterra-x1-logo-reveal.ecproj"));
writeLn("saved");
