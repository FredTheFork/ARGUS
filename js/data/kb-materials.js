/**
 * kb-materials.js — material composition knowledge.
 *
 * The material scorer is a small Bayesian-style vote between measurable image
 * cues and the priors below. Nothing here is a neural network: it is the
 * physical reasoning layer that turns "grey blob with hard highlights and near
 * zero texture" into "brushed metal, 78 percent", which is exactly the class of
 * question a vision model alone answers badly.
 *
 * Row format:
 *   name | adjectives | spec | texture | edge | sat | val | hue | classes | note
 *
 *   spec      0-1 how much mirror highlight the surface throws back
 *   texture   0-1 micro texture energy (matte grain, weave, pores)
 *   edge      0-1 strength of internal structure edges (weave, grain, joins)
 *   sat       0-1 expected colour saturation
 *   val       0-1 expected brightness
 *   hue       warm | cool | neutral | any | green | dark
 *   classes   comma list of classes that strongly imply this material
 */

export const MATERIALS = [
  // name|adjectives|spec|tex|edge|sat|val|hue|classes|note
  'metal|metallic,steel,alloy|0.72|0.18|0.42|0.20|0.55|neutral|spoon,knife,fork,wrench,hammer,bolt,filing cabinet,car,radiator,railings,lamppost|Specular highlights and a monochrome palette are the signature.',
  'brushed metal|brushed steel,satin|0.48|0.34|0.55|0.12|0.52|neutral|appliance,kettle,fridge,toaster,oven,laptop|Fine parallel grain, soft wide highlight rather than a hard point.',
  'chrome|chromed,polished chrome|0.94|0.06|0.30|0.06|0.72|neutral|tap,shower,door handle,towel rail,fitting|Near-mirror: it reflects the room, not its own colour.',
  'aluminium|aluminum,ally|0.66|0.22|0.35|0.10|0.70|neutral|laptop,phone,tablet,case,ladder,drone|Cool bright grey, thin anodised skin, very even tone.',
  'steel|stainless steel|0.70|0.20|0.38|0.08|0.58|neutral|sink,pan,saucepan,cutlery,mug,tool|',
  'cast iron|iron,enamel|0.30|0.45|0.50|0.10|0.30|dark|pan,weight,kettlebell,stove,radiator|Heavy, dark, softly mottled — rarely shiny except at the rim.',
  'brass|brazed,gold coloured metal|0.78|0.24|0.40|0.55|0.62|warm|door handle,valve,fitting,instrument|Warm yellow metal that tarnishes to a soft brown patina.',
  'copper|coppery,cuprite|0.74|0.26|0.42|0.62|0.58|warm|pipe,wire,cable,cookware|Red-orange metal; green verdigris when weathered.',
  'gold|gilt,golden metal|0.86|0.16|0.30|0.62|0.68|warm|ring,necklace,jewellery,medal,trophy|Soft warm yellow, almost never perfectly flat.',
  'silver|sterling silver|0.88|0.14|0.28|0.05|0.74|neutral|ring,cutlery,jewellery|Cool bright metal, quickly tarnished grey.',
  'plastic|polymer,abs|0.42|0.16|0.30|0.55|0.60|any|case,remote,keyboard,toy,bottle,chair,bin|Uniform colour, soft highlight, no grain at all.',
  'matte plastic|abs,soft touch|0.18|0.26|0.28|0.55|0.55|any|case,remote,keyboard,toy,handle|',
  'glossy plastic|acrylic,abs|0.68|0.08|0.24|0.60|0.65|any|bottle,casing,display,helmet|Sharp small highlight and a very flat mid-tone.',
  'rubber|elastomer,latex|0.16|0.44|0.34|0.15|0.28|dark|tyre,sole,mat,seal,glove|Matte with a dull micro-grain and a very low highlight.',
  'silicone|silastic|0.30|0.20|0.22|0.30|0.55|any|case,gasket,seal,kitchenware|Soft sheen, squishy edge, faint translucency at thin sections.',
  'glass|glazing,crystal|0.88|0.05|0.28|0.12|0.70|cool|window,bottle,glass,mirror,jar,vase|Hard specular point plus a visible transmission of what is behind.',
  'frosted glass|satin glass,obscured|0.55|0.22|0.18|0.08|0.78|cool|window,shower screen,lamp|Diffuse glow instead of a sharp reflection.',
  'ceramic|porcelain,stoneware|0.58|0.12|0.24|0.25|0.82|neutral|mug,plate,bowl,toilet,sink,tile,vase|Bright glaze over an edge that chips rather than flexes.',
  'terracotta|earthenware,clay|0.14|0.42|0.30|0.55|0.55|warm|pot,plant pot,tile,brick|Warm orange, matte, slightly porous grain.',
  'wood|timber,oak,pine|0.22|0.55|0.62|0.48|0.45|warm|table,chair,floor,door,board,bench,log|Long directional grain is the giveaway; look for the streaks.',
  'varnished wood|lacquered wood|0.52|0.30|0.55|0.50|0.45|warm|floor,table,furniture|Grain under a wet-looking coat.',
  'mdf|particle board,chipboard|0.20|0.35|0.22|0.30|0.60|neutral|furniture,cabinet,shelf,skirting|Perfectly flat face, no grain, edges look like compressed sawdust.',
  'veneer|laminate|0.34|0.40|0.48|0.45|0.48|warm|cabinet,worktop,floor|Printed grain: the repeats give it away when you look closely.',
  'leather|hide|0.32|0.52|0.44|0.42|0.32|warm|wallet,bag,shoe,sofa,chair,belt|Soft creases and pores; it catches light along every fold.',
  'faux leather|vinyl,pleather|0.46|0.30|0.30|0.45|0.42|any|sofa,bag,chair|Uniform pores and a faint plastic sheen.',
  'fabric|textile,cloth,woven|0.10|0.62|0.42|0.50|0.55|any|curtain,sofa,clothing,towel,t-shirt|Weave texture kills highlights: matte by definition.',
  'denim|jean|0.14|0.70|0.58|0.45|0.40|cool|jeans,trousers,jacket,bag|Deep blue twill, visible diagonal weave.',
  'canvas|duck,hessian|0.10|0.70|0.60|0.40|0.60|neutral|bag,tent,cover,canvas|Coarse visible weave, no sheen.',
  'wool|knit,fleece|0.06|0.72|0.50|0.40|0.55|any|jumper,scarf,sock,blanket|crimped fibre, matte, soft shadows inside every stitch.',
  'silk|satin|0.66|0.24|0.30|0.55|0.70|any|dress,tie,blouse|Sheen that slides as the surface curves.',
  'velvet|velour,plush|0.22|0.50|0.26|0.55|0.38|any|sofa,curtain,dress|Light goes in, not out: dark with a soft halo at the folds.',
  'paper|card,cardstock|0.12|0.30|0.24|0.25|0.88|neutral|book,box,note,poster,receipt|Bright, matte, and usually a touch of curl at the edge.',
  'cardboard|corrugated board|0.10|0.48|0.44|0.42|0.72|warm|box,carton,packaging|Flute pattern at the edges.',
  'stone|granite,marble,slate|0.34|0.62|0.58|0.15|0.55|neutral|worktop,floor,paving,monument|Mottled crystalline grain, hard specular points that never move.',
  'marble|polished stone|0.60|0.44|0.62|0.08|0.78|neutral|worktop,floor,statue|Veins are the signature, gloss on top of them.',
  'concrete|cement,render|0.16|0.66|0.40|0.10|0.60|neutral|wall,floor,pillar,kerb,block|Chalky, dead matte, slightly uneven tone.',
  'asphalt|tarmac,bitumen|0.20|0.72|0.48|0.10|0.25|dark|road,path,car park|cold black grit with a faint sheen in the sun.',
  'brick|masonry,clay brick|0.14|0.62|0.70|0.50|0.48|warm|wall,chimney,paving,building|Repeating units and mortar lines.',
  'plaster|drywall,gypsum|0.12|0.30|0.20|0.10|0.85|neutral|wall,ceiling|Flat, bright, with the odd faint scuff.',
  'tile|ceramic tile,porcelain|0.62|0.24|0.44|0.25|0.75|neutral|floor,bathroom,kitchen,splashback|Grid of joints, each face glossy.',
  'foliage|plant matter,leaves|0.16|0.78|0.66|0.62|0.42|green|plant,tree,leaf,hedge,shrub|Green and full of holes for light to pass through.',
  'skin|flesh|0.30|0.26|0.18|0.42|0.62|warm|person,hand,face,arm|Subsurface red; translucent at the shadow edge.',
  'hair|fur,pelt|0.24|0.70|0.36|0.40|0.35|any|hair,dog,cat,head|Directional strands, each a slightly different tone.',
  'feather|plumage,down|0.30|0.66|0.40|0.42|0.60|any|bird,wings,duvet|Overlapping soft barbs, iridescent on some species.',
  'water|liquid|0.80|0.14|0.20|0.20|0.62|cool|water,puddle,pool,wet|Either reflects the sky or shows what is under it.',
  'foam|sponge|0.08|0.58|0.30|0.30|0.78|any|sponge,seal,packaging,foam|Bright, matte, full of visible cells.',
  'lcd screen|display panel|0.78|0.04|0.30|0.45|0.55|cool|phone,telephone,tv,monitor,laptop,tablet,display|Its own light source: bright and boxy with a dark bezel.',
  'carbon fibre|composite,carbon|0.56|0.42|0.66|0.08|0.28|dark|bike,helmet,panel,drone|Tiny woven twill under a clear coat.',
  'paint|painted finish|0.30|0.20|0.24|0.55|0.60|any|door,wall,car,metal|Uniform colour, occasional runs or chips at the edge.',
  'rust|corroded iron,oxidation|0.10|0.72|0.52|0.55|0.42|warm|metal,fitting,gate,pipe|Orange-brown flaking — active corrosion, not a finish.',
  'enamel|vitreous enamel|0.72|0.10|0.26|0.40|0.72|any|oven,pans,sign,badge|Thick glass-like coat over metal, chips to a sharp edge.',
  'silicone sealant|caulk,mastic|0.44|0.18|0.16|0.15|0.80|neutral|seal,bathroom,kitchen|Smooth bead, faint sheen, slightly tacky look.',
  'epoxy|resin|0.66|0.10|0.22|0.35|0.55|any|worktop,art,table,coating|Deep gloss, sometimes with objects suspended in it.',
  'composite|fibreglass,grp|0.42|0.30|0.34|0.45|0.60|any|boat,panel,helmet,kayak|Flat colour with a faint gel-coat sheen.',
  'mesh|netting,gauze|0.20|0.80|0.74|0.35|0.50|any|net,fence,sieve,vent|Regular holes are the whole point.',
  'printed circuit|pcb,mainboard|0.36|0.48|0.86|0.35|0.40|green|circuit board,electronics,motherboard|Green substrate, dense repeating detail, gold pads.',
  'unknown|indeterminate|0.35|0.35|0.35|0.35|0.5|any||No confident material read — say so rather than guess.'
];

/**
 * Surface finish vocabulary derived from cue intensity, independent of material.
 * These become adjectives in the spoken description ("a glossy black ceramic
 * mug") and are what makes the output read like an observation rather than a
 * label dump.
 */
export const FINISHES = [
  { id: 'glossy', min: 0.62, word: 'glossy' },
  { id: 'satin', min: 0.42, word: 'satin' },
  { id: 'matte', min: 0.0, word: 'matte' }
];

/** Wear / condition descriptors — all of these are safety-relevant when seen. */
export const CONDITIONS = [
  { id: 'cracked', words: ['crack', 'cracked', 'shattered', 'broken glass'], note: 'Structural damage — do not use.' },
  { id: 'frayed', words: ['frayed', 'exposed', 'bare wire', 'damaged'], note: 'Damaged insulation is a shock and fire risk.' },
  { id: 'rusty', words: ['rust', 'rusted', 'corroded'], note: 'Corrosion weakens load-bearing metal.' },
  { id: 'wet', words: ['wet', 'spill', 'leak', 'puddle'], note: 'Slip hazard — 2 in 3 indoor falls start on a wet floor.' },
  { id: 'leaking', words: ['leak', 'leaking', 'drip'], note: 'Leaks reach electrics faster than you expect.' },
  { id: 'smouldering', words: ['smoke', 'smoulder', 'burning', 'scorch'], note: 'Uncontrolled smoke: leave by the nearest exit and raise the alarm.' }
];

/**
 * MATERIAL_ALIASES — the object knowledge base and the material scorer do not
 * have to use the same words.
 *
 * Object rows were written with natural material names ("cotton", "porcelain",
 * "fur", "stainless", "card"), while the scorer measures a fixed vocabulary of
 * 57 physical materials. Without this map, `materialsFor("duvet")` returns
 * "cotton", no scored material ever matches it, and the prior silently does
 * nothing. Tokens not listed here are left alone: for food and plant matter the
 * honest answer is that the cue-based scorer has no opinion, and inventing one
 * would put "bread" into a metal detector's answer.
 */
export const MATERIAL_ALIASES = {
  cotton: 'fabric', linen: 'fabric', polyester: 'fabric', nylon: 'fabric', silk: 'silk',
  fur: 'hair', bristle: 'hair', flesh: 'skin',
  porcelain: 'ceramic', crystal: 'glass', beads: 'glass',
  stainless: 'steel', 'carbon steel': 'steel', nonstick: 'metal', foil: 'aluminium',
  acrylic: 'glossy plastic', cladding: 'composite',
  latex: 'rubber', vinyl: 'faux leather',
  resin: 'epoxy', graphite: 'carbon fibre',
  varnish: 'varnished wood', laminate: 'veneer', cork: 'wood', bamboo: 'wood', wicker: 'wood',
  card: 'cardboard', carton: 'cardboard',
  granite: 'stone', slate: 'stone', sand: 'stone', masonry: 'brick', render: 'plaster',
  chalk: 'plaster', clay: 'terracotta', fibreglass: 'composite', grp: 'composite', coir: 'canvas', felt: 'wool', sponge: 'foam',
  leaf: 'foliage', leaves: 'foliage', grass: 'foliage', moss: 'foliage', stem: 'foliage',
  root: 'foliage', seed: 'foliage', petal: 'foliage', floret: 'foliage', wing: 'feather',
  liquid: 'water'
};

/** Resolve a knowledge-base material token to the scorer's vocabulary. */
export function canonicalMaterial(token) {
  const key = String(token || '').trim().toLowerCase();
  if (!key) return '';
  return MATERIAL_ALIASES[key] || key;
}
