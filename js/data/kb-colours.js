/**
 * kb-colours.js — the colour lexicon.
 *
 * Colour naming is done in CIE-Lab, not RGB: "is that cyan or teal" is a
 * perceptual question, and Euclidean distance in Lab tracks perception far
 * better than distance in RGB. Every cluster returned by the colour analyser is
 * matched against this table, so the assistant can say "petrol blue with a grey
 * shadow side" instead of "colour #2b5d6b".
 *
 * COLOURS rows: name | hex | family | note
 *   family is used when two names are equally close — the family of the object's
 *   own prior wins, which keeps a "grey metal kettle" from being called silver
 *   one frame and pewter the next.
 */

export const COLOURS = [
  // Neutrals first: they are the most common answer and the easiest to get wrong.
  'black|#000000|neutral|',
  'charcoal|#36454f|neutral|Soft black with a warm-grey bite.',
  'jet|#0f0f10|neutral|',
  'graphite|#383838|neutral|',
  'gunmetal|#2a3439|neutral|',
  'slate|#708090|neutral|',
  'grey|#808080|neutral|',
  'ash grey|#b2beb5|neutral|',
  'silver|#c0c0c0|neutral|',
  'light grey|#d3d3d3|neutral|',
  'pale grey|#e5e4e2|neutral|',
  'white|#ffffff|neutral|',
  'ivory|#fffff0|neutral|',
  'cream|#fffdd0|neutral|',
  'off white|#f5f5f0|neutral|',
  'eggshell|#f0ead6|neutral|',
  'beige|#f5f5dc|neutral|',
  'sand|#e3d5b8|neutral|',
  'tan|#d2b48c|neutral|',
  'khaki|#c3b091|neutral|',
  'taupe|#8b8589|neutral|',
  'greige|#c9c0b6|neutral|',
  'stone|#cabfb4|neutral|',
  'pewter|#96a0a0|neutral|',
  'anthracite|#2f3131|neutral|',
  'steel grey|#71797e|neutral|',
  'frost|#ecf0f1|neutral|',
  'smoke|#b9bab8|neutral|',
  'mushroom|#b6a99a|neutral|',
  'putty|#cfc7b5|neutral|',
  // Reds
  'red|#ff0000|red|',
  'crimson|#dc143c|red|',
  'scarlet|#ff2400|red|',
  'vermilion|#e34234|red|',
  'cherry|#d2042d|red|',
  'carmine|#a51c30|red|',
  'ruby|#9b111e|red|',
  'maroon|#800000|red|',
  'burgundy|#800020|red|',
  'oxblood|#4a0000|red|',
  'brick red|#b22222|red|',
  'rust|#b7410e|red|Deep orange-red: the colour of iron that has been left outside.',
  'terracotta|#cb6843|red|',
  'coral|#ff7f50|red|',
  'salmon|#fa8072|red|',
  'rose|#ff007f|red|',
  'pink|#ffc0cb|red|',
  'hot pink|#ff69b4|red|',
  'magenta|#ff00ff|red|',
  'fuchsia|#c154c1|red|',
  'raspberry|#b3446c|red|',
  'wine|#722f37|red|',
  'claret|#7f1734|red|',
  'blush|#de5d83|red|',
  // Oranges / browns
  'orange|#ffa500|orange|',
  'amber|#ffbf00|orange|',
  'apricot|#fbceb1|orange|',
  'tangerine|#f28500|orange|',
  'pumpkin|#ff7518|orange|',
  'peach|#ffe5b4|orange|',
  'mustard|#ffdb58|orange|',
  'ochre|#cc7722|orange|',
  'saffron|#f4c430|orange|',
  'brown|#8b4513|brown|',
  'chocolate|#7b3f00|brown|',
  'coffee|#6f4e37|brown|',
  'chestnut|#954535|brown|',
  'mahogany|#c04000|brown|',
  'walnut|#5c4033|brown|',
  'oak|#b08d57|brown|',
  'honey|#c98f2e|brown|',
  'caramel|#c68e17|brown|',
  'bronze|#cd7f32|brown|',
  'copper|#b87333|brown|Warm metal red-orange; vergris green when weathered.',
  'chestnut brown|#6b4423|brown|',
  'mocha|#7b5b43|brown|',
  'sepia|#704214|brown|',
  'umber|#635147|brown|',
  'bitter chocolate|#50342a|brown|',
  // Yellows
  'yellow|#ffff00|yellow|',
  'gold|#ffd700|yellow|',
  'lemon|#fff700|yellow|',
  'canary|#ffef00|yellow|',
  'butter|#ffe49c|yellow|',
  'maize|#fbec5d|yellow|',
  'straw|#e4d96f|yellow|',
  'flax|#eedc82|yellow|',
  'chartreuse|#dfff00|yellow|',
  'khaki yellow|#c3b091|yellow|',
  'brass|#b5a642|yellow|Warm yellow metal, dulled by handling.',
  'corn|#fbec5d|yellow|',
  // Greens
  'green|#008000|green|',
  'lime|#bfff00|green|',
  'olive|#808000|green|',
  'moss|#8a9a5b|green|',
  'forest green|#228b22|green|',
  'emerald|#50c878|green|',
  'jade|#00a86b|green|',
  'mint|#98ff98|green|',
  'sage|#9caf88|green|',
  'sea green|#2e8b57|green|',
  'teal|#008080|green|',
  'viridian|#40826d|green|',
  'pine|#014421|green|',
  'avocado|#568203|green|',
  'chartreuse green|#7fff00|green|',
  'kelly green|#4cbb17|green|',
  'pistachio|#93c572|green|',
  'malachite|#0bda51|green|',
  'bottle green|#006a4e|green|',
  // Cyans / blues
  'cyan|#00ffff|cyan|',
  'turquoise|#40e0d0|cyan|',
  'aquamarine|#7fffd4|cyan|',
  'teal blue|#367588|cyan|',
  'petrol|#005f6a|cyan|Dark blue-green: the colour of deep water and old enamel.',
  'sky blue|#87ceeb|blue|',
  'azure|#007fff|blue|',
  'cerulean|#2a52be|blue|',
  'cornflower|#6495ed|blue|',
  'blue|#0000ff|blue|',
  'royal blue|#4169e1|blue|',
  'cobalt|#0047ab|blue|',
  'sapphire|#0f52ba|blue|',
  'navy|#000080|blue|',
  'midnight blue|#191970|blue|',
  'denim|#1560bd|blue|',
  'steel blue|#4682b4|blue|',
  'periwinkle|#ccccff|blue|',
  'indigo|#4b0082|blue|',
  'prussian blue|#003153|blue|',
  'ice blue|#d6f2f8|blue|',
  'baby blue|#89cff0|blue|',
  'electric blue|#7df9ff|blue|',
  // Purples
  'purple|#800080|purple|',
  'violet|#8f00ff|purple|',
  'lavender|#e6e6fa|purple|',
  'lilac|#c8a2c8|purple|',
  'mauve|#e0b0ff|purple|',
  'plum|#8e4585|purple|',
  'orchid|#da70d6|purple|',
  'amethyst|#9966cc|purple|',
  'grape|#6f2da8|purple|',
  'aubergine|#3b0918|purple|',
  'royal purple|#7851a9|purple|',
  'mulberry|#c54b8c|purple|',
  // Metallics / specials
  'chrome|#dbe4eb|neutral|Mirror finish: it usually shows the room, not a colour.',
  'aluminium|#a9acb6|neutral|',
  'titanium|#878681|neutral|',
  'rose gold|#b76e79|red|',
  'gunmetal grey|#2a3439|neutral|',
  'iridescent|#a8b8c8|neutral|Shifts hue with the viewing angle.',
  'pearl|#f0e6d2|neutral|',
  'clear|#f2f7fa|neutral|Transparent or nearly so.',
  'transparent|#eaf4f8|neutral|See-through: colour is coming from what is behind it.',
  'opaque black|#0a0a0a|neutral|',
  'rust patina|#8a5a2b|brown|',
  'verdigris|#43b3ae|green|Copper that has been wet for years.'
];

/**
 * Colour modifiers — applied after the base name so a dark navy weave is
 * reported as "deep navy" rather than just "navy". Ordered; first match wins.
 */
export const COLOUR_MODIFIERS = [
  { id: 'deep', test: (l, c, h) => l < 32, word: 'deep', prefix: true },
  { id: 'pale', test: (l, c, h) => l > 82 && c < 34, word: 'pale', prefix: true },
  { id: 'vivid', test: (l, c, h) => c > 62, word: 'vivid', prefix: true },
  { id: 'muted', test: (l, c, h) => c < 16, word: 'muted', prefix: true },
  { id: 'warm', test: (l, c, h, warm) => warm && c > 12, word: 'warm', prefix: true },
  { id: 'cool', test: (l, c, h, warm) => !warm && c > 12, word: 'cool', prefix: true }
];

/** Hue families, used to snap near-ties and to drive the HUD's colour dot. */
export const HUE_FAMILIES = {
  neutral: { label: 'neutral', swatch: '#9aa3ab' },
  red: { label: 'red', swatch: '#e5484d' },
  orange: { label: 'orange', swatch: '#f2820b' },
  yellow: { label: 'yellow', swatch: '#e3c000' },
  green: { label: 'green', swatch: '#46a758' },
  cyan: { label: 'cyan', swatch: '#12a594' },
  blue: { label: 'blue', swatch: '#3e63dd' },
  purple: { label: 'purple', swatch: '#8e4ec6' },
  brown: { label: 'brown', swatch: '#a1683a' }
};

/**
 * Light-source colour temperatures the lighting estimator can report. Estimated
 * from the white-point of the frame, which is why "warm light" is said with a
 * confidence rather than as a fact.
 */
export const LIGHT_TEMPERATURES = [
  { id: 'candle', maxK: 2200, word: 'candlelight', note: 'very warm, low level' },
  { id: 'warm', maxK: 3200, word: 'warm light', note: 'tungsten or warm LED' },
  { id: 'neutral', maxK: 4800, word: 'neutral light', note: 'mixed or cool white' },
  { id: 'daylight', maxK: 6000, word: 'daylight', note: 'overcast sky or daylight LED' },
  { id: 'cool', maxK: 8000, word: 'cool light', note: 'north sky or cool white LED' },
  { id: 'shade', maxK: 12000, word: 'open shade', note: 'blue sky fill, no direct sun' }
];
