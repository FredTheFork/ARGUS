/**
 * kb.js — the recognition spine: knowledge base, lexicon and naming rules.
 *
 * This is where a raw model output becomes a specific thing. Three mechanisms
 * do the work:
 *
 *   1. TAXONOMY. ~800 curated objects (kb-objects*.js) plus the ImageNet-1k
 *      label set are merged into one vocabulary. Each entry carries category,
 *      material priors, colour priors, a real-world size, an interest tier and
 *      safety tags, so the same lookup answers "what is it", "how far is it",
 *      "is it worth speaking about" and "does it matter that I saw it".
 *
 *   2. ALIASES + FUZZ. Users say "socket", ImageNet says "switch", the detector
 *      says "cell phone" — all of those resolve to one record. Matching is
 *      case-folded, punctuation-stripped and tolerant of plurals and one edit.
 *
 *   3. NAMING. `nameFor()` composes the most specific honest label available:
 *      detected class, refined by classifier evidence, qualified by brand text
 *      read off the object, described by colour and material. It is the
 *      difference between "phone" and "matte black Apple iPhone".
 */

import { OBJECTS_1 } from './data/kb-objects.js';
import { OBJECTS_2 } from './data/kb-objects2.js';
import { MATERIALS, FINISHES, CONDITIONS } from './data/kb-materials.js';
import { COLOURS, HUE_FAMILIES, LIGHT_TEMPERATURES } from './data/kb-colours.js';
import { BRANDS, SIGN_LEXICON } from './data/kb-brands.js';
import { IMAGENET_LABELS } from './data/imagenet.js';
import { rgbToLab, deltaE } from './core.js';

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

const DEFAULT_COLOUR = ['black', 'white', 'grey', 'silver'];

function parseRows(block) {
  const out = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split('|').map((s) => s.trim());
    const [name, aliases, category, materials, colours, height, tier, tags, note] = f;
    if (!name) continue;
    out.push({
      name,
      aliases: aliases ? aliases.split(',').map((s) => s.trim()).filter(Boolean) : [],
      category: category || 'misc',
      materials: materials ? materials.split(',').map((s) => s.trim()).filter(Boolean) : [],
      colours: colours ? colours.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_COLOUR,
      height: Number(height) || 0,
      tier: Number(tier) || 1,
      tags: tags ? tags.split(',').map((s) => s.trim()).filter(Boolean) : [],
      note: note || ''
    });
  }
  return out;
}

export const OBJECTS = [...parseRows(OBJECTS_1), ...parseRows(OBJECTS_2)];

/* ------------------------------------------------------------------ *
 * ImageNet refinement
 *
 * EfficientNet-Lite4 answers in ImageNet vocabulary, which is broader than
 * COCO but idiosyncratic: "iPod", "hard disc", "space bar", "theodolite". This
 * table maps the classes that matter onto ARGUS vocabulary and, where the class
 * is simply noise at crop scale, marks it suppressed.
 * ------------------------------------------------------------------ */

export const IMAGENET_REFINE = {
  'iPod': 'phone', 'cellular telephone': 'phone', 'dial telephone': 'telephone',
  'pay-phone': 'telephone', 'modem': 'router', 'hard disc': 'external hard drive',
  'CD player': 'turntable', 'cassette player': 'cassette', 'tape player': 'cassette',
  'radio': 'radio', 'television': 'television', 'screen': 'monitor', 'monitor': 'monitor',
  'laptop': 'laptop', 'notebook': 'notebook', 'desktop computer': 'desktop computer',
  'hand-held computer': 'tablet', 'computer keyboard': 'keyboard', 'space bar': 'keyboard',
  'mouse': 'mouse', 'joystick': 'games controller', 'remote control': 'remote control',
  'webcam': 'webcam', 'printer': 'printer', 'photocopier': 'photocopier', 'scanner': 'scanner',
  'digital watch': 'watch', 'analog clock': 'clock', 'wall clock': 'wall clock',
  'digital clock': 'clock', 'stopwatch': 'stopwatch', 'hourglass': 'hourglass',
  'table lamp': 'lamp', 'lampshade': 'lampshade', 'chandelier': 'chandelier',
  'spotlight': 'lamp', 'candle': 'candle', 'torch': 'torch', 'lighter': 'lighter',
  'matchstick': 'matches', 'power drill': 'power drill', 'chain saw': 'chainsaw',
  'lawn mower': 'lawn mower', 'vacuum': 'vacuum', 'washer': 'washing machine',
  'dishwasher': 'dishwasher', 'refrigerator': 'refrigerator', 'microwave': 'microwave',
  'toaster': 'toaster', 'rotisserie': 'oven', 'Dutch oven': 'oven', 'caldron': 'saucepan',
  'frying pan': 'frying pan', 'wok': 'wok', 'spatula': 'spatula', 'ladle': 'ladle',
  'strainer': 'colander', 'colander': 'colander', 'saltshaker': 'salt shaker',
  'corkscrew': 'corkscrew', 'can opener': 'can opener', 'cleaver': 'cleaver',
  'letter opener': 'utility knife', 'carving knife': 'knife', 'butcher shop': 'shop front',
  'coffeepot': 'coffee machine', 'espresso maker': 'espresso machine', 'teapot': 'teapot',
  'waffle iron': 'toaster', 'electric fan': 'electric fan', 'space heater': 'space heater',
  'hair dryer': 'hair dryer', 'hair slide': 'hair clip', 'hair spray': 'hairbrush',
  'oxygen mask': 'oxygen mask', 'gas mask': 'face mask', 'pill bottle': 'pill bottle',
  'syringe': 'syringe', 'stethoscope': 'stethoscope', 'band aid': 'plaster',
  'medicine chest': 'cabinet', 'scale': 'scales', 'bath towel': 'towel', 'washbasin': 'sink',
  'shower cap': 'hair clip', 'soap dispenser': 'soap dispenser', 'toilet seat': 'toilet',
  'toilet tissue': 'toilet roll', 'paper towel': 'kitchen roll', 'plunger': 'plunger',
  'broom': 'brush', 'mop': 'mop', 'bucket': 'bucket', 'dustpan': 'dustpan',
  'vacuum cleaner': 'vacuum', 'crate': 'crate', 'carton': 'cardboard box', 'packet': 'cardboard box',
  'wooden spoon': 'spoon', 'soup bowl': 'bowl', 'mixing bowl': 'mixing bowl',
  'coffee mug': 'mug', 'cup': 'cup', 'beer glass': 'pint glass', 'goblet': 'wine glass',
  'wine bottle': 'wine bottle', 'beer bottle': 'bottle', 'water bottle': 'water bottle',
  'pop bottle': 'bottle', 'pillow': 'pillow', 'cushion': 'pillow', 'quilt': 'duvet',
  'comforter': 'duvet', 'sleeping bag': 'sleeping bag', 'mosquito net': 'net',
  'shower curtain': 'curtain', 'window shade': 'window blind', 'window screen': 'window',
  'sliding door': 'door', 'doormat': 'door mat', 'safe': 'safe', 'padlock': 'padlock',
  'combination lock': 'padlock', 'chain': 'chain', 'hook': 'hook', 'nail': 'nail',
  'screw': 'screw', 'safety pin': 'safety pin', 'buckle': 'buckle', 'clothes iron': 'iron',
  'sewing machine': 'sewing machine', 'thimble': 'thimble', 'spindle': 'spool',
  'pencil sharpener': 'sharpener', 'rubber eraser': 'eraser', 'pencil box': 'pencil case',
  'ballpoint': 'pen', 'fountain pen': 'pen', 'quill': 'pen', 'paintbrush': 'paint brush',
  'crayon': 'crayon', 'notebook, notebook computer': 'laptop', 'binder': 'folder',
  'looseleaf binder': 'folder', 'file': 'folder', 'envelope': 'envelope',
  'basket': 'shopping basket', 'shopping basket': 'shopping basket',
  'shopping cart': 'shopping trolley', 'vending machine': 'vending machine',
  'slot machine': 'slot machine', 'cash machine': 'atm', 'pay-phone booth': 'telephone box',
  'parking meter': 'parking meter', 'traffic light': 'traffic light', 'street sign': 'road sign',
  'gasmask': 'face mask', 'fire engine': 'fire engine', 'police van': 'police car',
  'ambulance': 'ambulance', 'garbage truck': 'truck', 'tow truck': 'truck',
  'trailer truck': 'truck', 'moving van': 'van', 'minibus': 'bus', 'school bus': 'bus',
  'trolleybus': 'bus', 'snowplow': 'truck', 'half track': 'vehicle', 'go-kart': 'vehicle',
  'moped': 'scooter', 'mountain bike': 'bicycle', 'tricycle': 'bicycle',
  'motor scooter': 'scooter', 'forklift': 'forklift', 'crane': 'crane',
  'bulldozer': 'bulldozer', 'tractor': 'tractor', 'harvester': 'tractor',
  'golf cart': 'vehicle', 'ambulance': 'ambulance',
  'backpack': 'backpack', 'rucksack': 'backpack', 'purse': 'wallet', 'wallet': 'wallet',
  'umbrella': 'umbrella', 'suitcase': 'suitcase', 'briefcase': 'briefcase',
  'mailbag': 'bag', 'plastic bag': 'plastic bag', 'shopping bag': 'bag',
  'running shoe': 'trainers', 'clog': 'shoes', 'cowboy boot': 'boots', 'sandal': 'shoes',
  'Loafer': 'shoes', 'sock': 'socks', 'mitten': 'gloves', 'sunglass': 'sunglasses',
  'sunglasses': 'sunglasses', 'bow tie': 'tie', 'bolo tie': 'tie', 'Windsor tie': 'tie',
  'jersey': 'shirt', 'sweatshirt': 'hoodie', 'jean': 'jeans', 'miniskirt': 'skirt',
  'sarong': 'skirt', 'bikini': 'swimwear', 'swimming trunks': 'swimwear', 'kimono': 'dress',
  'abaya': 'dress', 'lab coat': 'lab coat', 'apron': 'apron', 'poncho': 'coat',
  'fur coat': 'coat', 'trench coat': 'coat', 'cardigan': 'jumper', 'sweater': 'jumper',
  'wool': 'wool', 'velvet': 'velvet', 'denim': 'denim', 'leather': 'leather',
  'Christmas stocking': 'socks', 'brassiere': 'clothing', 'maillot': 'swimwear',
  'sombrero': 'hat', 'cowboy hat': 'hat', 'bonnet': 'hat', 'mortarboard': 'hat',
  'bearskin': 'hat', 'shower cap': 'hair clip', 'wig': 'hair', 'hairpiece': 'hair',
  'necklace': 'necklace', 'earring': 'earring', 'bracelet': 'bracelet',
  'ring': 'ring', 'watch': 'watch', 'chain saw': 'chainsaw',
  'screwdriver': 'screwdriver', 'hammer': 'hammer', 'hatchet': 'axe', 'cleaver': 'cleaver',
  'power drill': 'power drill', 'plane': 'plane tool', 'chisel': 'chisel',
  'spirit level': 'level', 'measuring cup': 'measuring jug', 'ruler': 'ruler',
  'yardstick': 'ruler', 'abacus': 'calculator',
  'guitar': 'guitar', 'acoustic guitar': 'guitar', 'electric guitar': 'guitar',
  'banjo': 'banjo', 'violin': 'violin', 'cello': 'cello', 'upright piano': 'piano',
  'grand piano': 'piano', 'organ': 'piano', 'drum': 'drum', 'drumstick': 'drum',
  'maraca': 'drum', 'flute': 'flute', 'oboe': 'clarinet', 'bassoon': 'clarinet',
  'sax': 'saxophone', 'trombone': 'trumpet', 'cornet': 'trumpet', 'French horn': 'trumpet',
  'harmonica': 'harmonica', 'accordion': 'accordion', 'ocarina': 'flute',
  'banana': 'banana', 'apple': 'apple', 'orange': 'orange', 'lemon': 'lemon',
  'strawberry': 'strawberry', 'pineapple': 'pineapple', 'pomegranate': 'fruit',
  'fig': 'fruit', 'jackfruit': 'fruit', 'custard apple': 'fruit',
  'Granny Smith': 'apple', 'head cabbage': 'cabbage', 'broccoli': 'broccoli',
  'cauliflower': 'cauliflower', 'cucumber': 'cucumber', 'artichoke': 'vegetable',
  'bell pepper': 'pepper', 'mushroom': 'mushroom', 'corn': 'sweetcorn',
  'spaghetti squash': 'squash', 'acorn squash': 'squash', 'butternut squash': 'squash',
  'potato': 'potato', 'carrot': 'carrot', 'onion': 'onion', 'garlic': 'garlic',
  'bagel': 'bagel', 'pretzel': 'bread', 'French loaf': 'bread', 'loaf of bread': 'bread',
  'pizza': 'pizza', 'hotdog': 'hot dog', 'cheeseburger': 'burger', 'hamburger': 'burger',
  'ice cream': 'ice cream', 'ice lolly': 'ice cream', 'dough': 'food',
  'chocolate sauce': 'chocolate', 'meat loaf': 'meat', 'carbonara': 'pasta',
  'eggnog': 'drink', 'espresso': 'coffee', 'cup of coffee': 'coffee', 'red wine': 'wine',
  'beer bottle': 'bottle', 'beer glass': 'pint glass',
  'tabby': 'cat', 'tiger cat': 'cat', 'Persian cat': 'cat', 'Siamese cat': 'cat',
  'Egyptian cat': 'cat', 'kitten': 'kitten', 'dog': 'dog', 'golden retriever': 'dog',
  'Labrador retriever': 'dog', 'German shepherd': 'dog', 'border collie': 'dog',
  'cocker spaniel': 'dog', 'puppy': 'puppy', 'great Dane': 'dog', 'pug': 'dog',
  'Chihuahua': 'dog', 'malamute': 'dog', 'Siberian husky': 'dog', 'dalmatian': 'dog',
  'ox': 'cow', 'bull': 'cow', 'cow': 'cow', 'sheep': 'sheep', 'ram': 'sheep', 'ewe': 'sheep',
  'hog': 'pig', 'piglet': 'pig', 'goat': 'goat', 'ibex': 'goat', 'horse': 'horse',
  'sorrel': 'horse', 'zebra': 'zebra', 'elephant': 'elephant', 'camel': 'camel',
  'giraffe': 'giraffe', 'hippopotamus': 'animal', 'rhinoceros': 'animal',
  'lion': 'animal', 'tiger': 'animal', 'leopard': 'animal', 'cheetah': 'animal',
  'brown bear': 'animal', 'polar bear': 'animal', 'fox': 'fox', 'wolf': 'animal',
  'rabbit': 'rabbit', 'hare': 'rabbit', 'squirrel': 'squirrel', 'mouse': 'mouse',
  'rat': 'rat', 'hamster': 'hamster', 'guinea pig': 'hamster', 'porcupine': 'animal',
  'kangaroo': 'animal', 'koala': 'animal', 'panda': 'animal', 'sloth': 'animal',
  'otter': 'animal', 'skunk': 'animal', 'badger': 'animal', 'weasel': 'animal',
  'mongoose': 'animal', 'meerkat': 'animal', 'lynx': 'animal',
  'robin': 'bird', 'jay': 'bird', 'magpie': 'bird', 'chickadee': 'bird',
  'kite bird': 'bird', 'bald eagle': 'bird', 'vulture': 'bird', 'ostrich': 'bird',
  'peacock': 'bird', 'parrot': 'bird', 'macaw': 'bird', 'cockatoo': 'bird',
  'hummingbird': 'bird', 'toucan': 'bird', 'duck': 'duck', 'goose': 'duck',
  'black swan': 'swan', 'hen': 'hen', 'cock': 'hen', 'turkey': 'hen',
  'goldfish': 'fish', 'tench': 'fish', 'barracouta': 'fish', 'eel': 'fish',
  'stingray': 'fish', 'shark': 'fish', 'jellyfish': 'jellyfish', 'coral reef': 'animal',
  'snail': 'snail', 'slug': 'snail', 'spider': 'spider', 'tarantula': 'spider',
  'scorpion': 'animal', 'bee': 'bee', 'ant': 'ant', 'butterfly': 'butterfly',
  'dragonfly': 'insect', 'grasshopper': 'insect', 'cricket': 'insect',
  'beetle': 'insect', 'ladybug': 'insect', 'fly': 'insect', 'mosquito': 'insect',
  'cockroach': 'insect', 'mantis': 'insect', 'stick insect': 'insect', 'worm': 'worm',
  'lizard': 'lizard', 'iguana': 'lizard', 'chameleon': 'lizard', 'gecko': 'lizard',
  'crocodile': 'animal', 'alligator': 'animal', 'turtle': 'animal', 'snake': 'snake',
  'cobra': 'snake', 'python': 'snake', 'viper': 'snake', 'frog': 'frog', 'toad': 'frog',
  'daisy': 'flower', 'rose': 'flower', 'sunflower': 'flower', 'tulip': 'flower',
  'orchid': 'flower', 'poppy': 'flower', 'dandelion': 'flower', 'pot': 'plant pot',
  'houseplant': 'houseplant', 'potted plant': 'houseplant', 'tree': 'tree',
  'oak': 'tree', 'palm': 'tree', 'pine': 'tree', 'mushroom': 'mushroom',
  'yellow lady\'s slipper': 'flower', 'rapeseed': 'plant', 'corn': 'sweetcorn',
  'buckeye': 'seed', 'acorn': 'seed', 'hip': 'fruit',
  'bookcase': 'bookcase', 'bookshelf': 'bookcase', 'bookshop': 'shop front',
  'comic book': 'book', 'book jacket': 'book', 'menu': 'menu', 'binder': 'folder',
  'crossword puzzle': 'puzzle', 'jigsaw puzzle': 'puzzle',
  'chiffonier': 'sideboard', 'china cabinet': 'cabinet', 'cabinet': 'cabinet',
  'file cabinet': 'filing cabinet', 'filing cabinet': 'filing cabinet',
  'dining table': 'table', 'desk': 'desk', 'pool table': 'table', 'table lamp': 'lamp',
  'rocking chair': 'chair', 'folding chair': 'chair', 'barber chair': 'chair',
  'throne': 'chair', 'studio couch': 'sofa', 'sofa': 'sofa', 'couch': 'sofa',
  'four-poster': 'bed', 'crib': 'cot', 'bassinet': 'cot', 'cradle': 'cot',
  'wardrobe': 'wardrobe', 'chest': 'chest of drawers', 'dresser': 'chest of drawers',
  'medicine chest': 'cabinet', 'shelf': 'shelf', 'safe': 'safe', 'vase': 'vase',
  'pot': 'plant pot', 'flowerpot': 'plant pot', 'lampshade': 'lampshade',
  'mirror': 'mirror', 'window shade': 'window blind', 'curtain': 'curtain',
  'carpet': 'carpet', 'doormat': 'door mat', 'prayer rug': 'rug', 'quilt': 'duvet',
  'pillow': 'pillow', 'cushion': 'pillow', 'towel': 'towel', 'bath towel': 'towel',
  'apron': 'apron', 'bib': 'apron', 'pinafore': 'apron',
  'typewriter keyboard': 'keyboard', 'cash register': 'cash register',
  'computer keyboard': 'keyboard', 'mouse': 'mouse', 'mousepad': 'mouse mat',
  'monitor': 'monitor', 'screen': 'monitor', 'television': 'television',
  'projector': 'projector', 'loudspeaker': 'speaker', 'microphone': 'microphone',
  'headphones': 'headphones', 'earphone': 'earbuds', 'radio': 'radio',
  'camera': 'camera', 'reflex camera': 'camera', 'Polaroid camera': 'camera',
  'lens cap': 'camera lens', 'tripod': 'tripod', 'binoculars': 'binoculars',
  'telescope': 'telescope', 'microscope': 'microscope', 'digital clock': 'clock',
  'oscilloscope': 'instrument', 'seismograph': 'instrument', 'theodolite': 'instrument',
  'slide rule': 'calculator', 'calculator': 'calculator', 'abacus': 'calculator',
  'photocopier': 'photocopier', 'printer': 'printer', 'scanner': 'scanner',
  'hard disc': 'external hard drive', 'tape drive': 'hard drive', 'diskette': 'floppy disk',
  'CD': 'cd', 'DVD': 'dvd', 'cassette': 'cassette', 'vinyl': 'vinyl record',
  'iPod': 'phone', 'cellular telephone': 'phone', 'dial telephone': 'telephone',
  'pay-phone': 'telephone', 'telephone bell': 'telephone', 'hand-held computer': 'tablet',
  'notebook, notebook computer': 'laptop', 'laptop': 'laptop', 'desktop computer': 'desktop computer',
  'modem': 'router', 'router': 'router', 'network switch': 'network switch',
  'power drill': 'power drill', 'electric fan': 'electric fan',
  'space heater': 'space heater', 'radiator': 'radiator', 'stove': 'hob',
  'Dutch oven': 'oven', 'rotisserie': 'oven', 'microwave': 'microwave',
  'toaster': 'toaster', 'waffle iron': 'toaster', 'espresso maker': 'espresso machine',
  'coffeepot': 'coffee machine', 'teapot': 'teapot', 'kettle': 'kettle',
  'water jug': 'jug', 'pitcher': 'jug', 'beer pitcher': 'jug', 'vase': 'vase',
  'pot': 'plant pot', 'crock pot': 'slow cooker', 'frying pan': 'frying pan',
  'wok': 'wok', 'caldron': 'saucepan', 'Dutch oven': 'oven',
  'seat belt': 'seatbelt', 'car wheel': 'car wheel', 'wheel': 'car wheel',
  'car mirror': 'mirror', 'grille': 'vent', 'radiator grille': 'vent',
  'license plate': 'number plate', 'traffic light': 'traffic light',
  'street sign': 'road sign', 'traffic sign': 'road sign', 'speed limit': 'road sign',
  'pillar box': 'post box', 'post box': 'post box', 'mailbox': 'post box',
  'birdhouse': 'bird box', 'bird feeder': 'bird feeder', 'birdbath': 'bird bath',
  'patio': 'patio', 'gazebo': 'gazebo', 'greenhouse': 'greenhouse',
  'barn': 'barn', 'lighthouse': 'lighthouse', 'castle': 'castle', 'palace': 'building',
  'monastery': 'building', 'church': 'church', 'mosque': 'mosque', 'dome': 'dome',
  'bell cote': 'church', 'vault': 'building', 'altar': 'building', 'triumphal arch': 'arch',
  'stone wall': 'wall', 'picket fence': 'fence', 'chainlink fence': 'fence',
  'chain-link fence': 'fence', 'fence': 'fence', 'dam': 'dam', 'viaduct': 'bridge',
  'steel arch bridge': 'bridge', 'suspension bridge': 'bridge', 'pier': 'pier',
  'dock': 'dock', 'fountain': 'fountain', 'parking meter': 'parking meter',
  'pay-phone': 'telephone', 'beacon': 'lighthouse', 'solar dish': 'satellite dish',
  'radio telescope': 'satellite dish', 'parachute': 'parachute', 'airship': 'airship',
  'balloon': 'balloon', 'airliner': 'airplane', 'warplane': 'airplane',
  'space shuttle': 'airplane', 'catamaran': 'boat', 'trimaran': 'boat',
  'container ship': 'ship', 'liner': 'ship', 'yawl': 'boat', 'schooner': 'boat',
  'lifeboat': 'boat', 'gondola': 'boat', 'speedboat': 'boat', 'fireboat': 'boat',
  'aircraft carrier': 'ship', 'submarine': 'submarine', 'paddlewheel': 'boat',
  'scoreboard': 'scoreboard', 'punching bag': 'punching bag', 'punching bag': 'punching bag',
  'barbell': 'barbell', 'dumbbell': 'dumbbell', 'yoga': 'yoga mat',
  'horizontal bar': 'gym equipment', 'parallel bars': 'gym equipment',
  'balance beam': 'gym equipment', 'treadmill': 'treadmill', 'rowing machine': 'gym equipment',
  'stairmaster': 'gym equipment', 'skipping rope': 'skipping rope',
  'soccer ball': 'football', 'basketball': 'basketball', 'volleyball': 'volleyball',
  'golf ball': 'golf ball', 'ping-pong ball': 'ball', 'tennis ball': 'tennis ball',
  'croquet ball': 'ball', 'rugby ball': 'rugby ball', 'baseball': 'baseball',
  'cricket ball': 'cricket ball', 'puck': 'puck', 'racket': 'tennis racket',
  'tennis racket': 'tennis racket', 'badminton racket': 'badminton racket',
  'baseball bat': 'baseball bat', 'cricket bat': 'cricket bat', 'hockey stick': 'hockey stick',
  'golf club': 'golf club', 'skis': 'skis', 'ski': 'skis', 'snowboard': 'snowboard',
  'surfboard': 'surfboard', 'paddle': 'paddle', 'canoe': 'canoe', 'kayak': 'kayak',
  'parachute': 'parachute', 'trampoline': 'trampoline', 'swing': 'swing',
  'seesaw': 'seesaw', 'carousel': 'merry-go-round', 'Ferris wheel': 'ferris wheel',
  'swimming cap': 'swimming goggles', 'snorkel': 'swimming goggles',
  'oxygen mask': 'oxygen mask', 'gas mask': 'face mask', 'breastplate': 'armour',
  'shield': 'shield', 'helmet': 'hard hat', 'crash helmet': 'hard hat',
  'football helmet': 'hard hat', 'bulletproof vest': 'body armour',
  'assault rifle': 'weapon', 'revolver': 'weapon', 'rifle': 'weapon', 'cannon': 'weapon',
  'bomb': 'hazard', 'missile': 'weapon', 'projectile': 'weapon', 'bow': 'weapon',
  'crossbow': 'weapon', 'sword': 'blade', 'knife': 'knife', 'dagger': 'knife',
  'cleaver': 'cleaver', 'axe': 'axe', 'hatchet': 'axe', 'sickle': 'sickle',
  'scythe': 'scythe', 'lawn mower': 'lawn mower',
  'pencil sharpener': 'sharpener', 'pencil box': 'pencil case', 'crayon': 'crayon',
  'chalk': 'chalk', 'notebook': 'notebook', 'binder': 'folder',
  'bath towel': 'towel', 'teddy': 'teddy bear', 'teddy bear': 'teddy bear',
  'toyshop': 'toy shop', 'doll': 'doll', 'puppet': 'puppet', 'pinwheel': 'pinwheel',
  'kite': 'kite', 'balloon': 'balloon', 'jigsaw puzzle': 'puzzle'
};

/** ImageNet classes whose crop-level answers are usually noise. */
export const IMAGENET_NOISE = new Set([
  'theodolite', 'seismograph', 'oscilloscope', 'slide rule', 'abacus', 'spindle',
  'comic book', 'menu', 'crossword puzzle', 'jigsaw puzzle', 'book jacket',
  'ballpoint', 'quill', 'fountain pen', 'pencil box', 'rubber eraser',
  'safety pin', 'buckle', 'hook', 'nail', 'screw', 'chain', 'knot',
  'wallpaper', 'tile roof', 'thatch', 'stone wall', 'chainlink fence',
  'spotlight', 'stage', 'theater curtain', 'window shade', 'window screen',
  'plunger', 'swab', 'water jug', 'measuring cup', 'pill bottle', 'beaker',
  'light bulb', 'lampshade', 'switch', 'plug', 'radiator', 'grille', 'screen',
  'solar dish', 'traffic light', 'street sign', 'patio', 'gazebo', 'birdbath'
]);

/* ------------------------------------------------------------------ *
 * Category inference
 *
 * ImageNet labels arrive without any taxonomy of their own. Keywords get them
 * most of the way; the explicit table above catches the rest. Categories drive
 * HUD colour, the spoken register and the scene inference.
 * ------------------------------------------------------------------ */

const CATEGORY_RULES = [
  [/^(person|man|woman|child|baby|boy|girl|face|hair|hand|scuba diver|bridegroom|groom|ballplayer|baseball player|chef|nurse|police|soldier|firefighter|academic gown|military uniform|kimono|abaya|sarong|bikini|swimming trunks|jersey|sweatshirt|jean|miniskirt|poncho|lab coat|apron|suit|trench coat|fur coat|cardigan|sweater|wool|velvet|denim|leather|brassiere|maillot|sock|mitten|sunglass|bow tie|bolo tie|Windsor tie|cowboy boot|clog|running shoe|sandal|Loafer|sombrero|cowboy hat|bonnet|mortarboard|bearskin|shower cap|wig|hairpiece)/i, 'clothing'],
  [/(dog|cat|kitten|puppy|retriever|terrier|spaniel|shepherd|collie|husky|pug|chihuahua|dalmatian|poodle|malamute|pinscher|schnauzer|setter|hound|bull|ox|cow|sheep|ram|ewe|goat|ibex|horse|zebra|elephant|camel|giraffe|hippopotamus|rhinoceros|lion|tiger|leopard|cheetah|bear|fox|wolf|rabbit|hare|squirrel|mouse|rat|hamster|guinea pig|porcupine|kangaroo|koala|panda|sloth|otter|skunk|badger|weasel|mongoose|meerkat|lynx|bison|wombat|wallaby|platypus|armadillo|hippo|seal|sea lion|dolphin|whale|bird|robin|jay|magpie|chickadee|eagle|vulture|ostrich|peacock|parrot|macaw|cockatoo|hummingbird|toucan|duck|goose|swan|hen|cock|turkey|penguin|albatross|flamingo|heron|stork|pelican|kingfisher|woodpecker|finch|sparrow|wren|oriole|brambling|goldfinch|junco|bulbul|indigo bunting|kite|vulture|fish|goldfish|tench|barracouta|eel|stingray|shark|jellyfish|anemone|coral|snail|slug|spider|tarantula|scorpion|bee|ant|butterfly|dragonfly|grasshopper|cricket|beetle|ladybug|fly|mosquito|cockroach|mantis|stick insect|worm|lizard|iguana|chameleon|gecko|crocodile|alligator|turtle|snake|cobra|python|viper|frog|toad)/i, 'animal'],
  [/(flower|daisy|rose|sunflower|tulip|orchid|poppy|dandelion|rapeseed|pot|houseplant|potted plant|tree|oak|palm|pine|mushroom|buckeye|acorn|hip|lady's slipper|corn|broccoli|cauliflower|cabbage|cucumber|artichoke|pepper|squash|zucchini|vegetable|plant|leaf|moss|fern|ivy|vine|cactus|succulent|herb|seed|grain|hay|thatch|grass|shrub|hedge|bonzai)/i, 'plant'],
  [/(apple|banana|orange|lemon|strawberry|pineapple|pomegranate|fig|jackfruit|custard apple|Granny Smith|pretzel|bagel|French loaf|loaf|pizza|hotdog|cheeseburger|hamburger|ice cream|ice lolly|dough|chocolate|meat loaf|carbonara|eggnog|espresso|coffee|red wine|beer|plate|soup|consomme|trifle|guacamole|mashed potato|head cabbage|mushroom|corn|potato|carrot|onion|garlic|fruit|food|dish|tray|menu)/i, 'food'],
  [/(car|taxi|cab|minibus|bus|trolleybus|truck|van|trailer|snowplow|moped|bicycle|bike|tricycle|motor|scooter|forklift|crane|bulldozer|tractor|harvester|limousine|convertible|jeep|pickup|ambulance|fire engine|police van|garbage truck|tow truck|racer|sports car|go-kart|golf cart|wheelchair|airliner|warplane|space shuttle|airship|balloon|catamaran|trimaran|container ship|liner|yawl|schooner|lifeboat|gondola|speedboat|fireboat|aircraft carrier|submarine|paddlewheel|steam locomotive|electric locomotive|bullet train|freight car|passenger car|tank|half track|trailer truck|moving van|horse cart|dog sled|paddlewheel)/i, 'vehicle'],
  [/(keyboard|monitor|screen|television|laptop|notebook|computer|mouse|joystick|remote|webcam|printer|photocopier|scanner|modem|router|disc|diskette|cassette|iPod|phone|telephone|camera|lens|projector|microphone|loudspeaker|headphone|earphone|radio|amplifier|oscilloscope|theodolite|calculator|oscilloscope|dial telephone|pay-phone|hand-held computer|hard disc|tape drive|CD player|DVD player|tape player|digital clock|digital watch|slot machine|cash machine|vending machine|cash register|typewriter)/i, 'tech'],
  [/(drill|saw|hammer|screwdriver|spanner|wrench|pliers|axe|hatchet|cleaver|knife|dagger|sword|sickle|scythe|chisel|plane|ladle|spatula|wok|pan|strainer|colander|corkscrew|can opener|peeler|grater|whisk|scissors|shears|file|nail|screw|bolt|chain|padlock|combination lock|scale|ruler|yardstick|level|trowel|ladder|tool|mower|shovel|rake|hoe|pitchfork|hoe|pick|skewer|crutch|broom|mop|bucket|dustpan|wheelbarrow|watering can|hose|plunger)/i, 'tool'],
  [/(table|chair|sofa|couch|bed|crib|cot|wardrobe|dresser|chest|bookcase|bookshelf|cabinet|shelf|desk|bench|stool|throne|bassinet|cradle|rocking chair|folding chair|barber chair|studio couch|four-poster|pool table|dining table|sideboard|chiffonier|china cabinet|file cabinet|filing cabinet|lamp|lampshade|mirror|curtain|window shade|carpet|rug|quilt|pillow|cushion|duvet|mattress|easel|lectern|podium)/i, 'furniture'],
  [/(mug|cup|glass|goblet|bottle|jar|jug|pitcher|bowl|plate|dish|teapot|kettle|saucepan|pan|tray|flask|thermos|tin|can|box|carton|crate|basket|bag|packet|bottlecap|vase|pot|barrel|keg|tub|bin|bucket|container)/i, 'container'],
  [/(sock|shirt|tie|jacket|coat|trousers|pants|jean|skirt|dress|shoe|boot|hat|cap|glove|mitten|scarf|belt|sweater|jumper|hoodie|t-shirt|vest|apron|bib|gown|uniform|swimwear|bikini|maillot|cloth|fabric|textile|wool|velvet|denim|leather|linen|nylon|polyester|silk|satin|towel|blanket|duvet|quilt|carpet|rug|curtain)/i, 'clothing'],
  [/(sign|poster|billboard|plate|plaque|badge|banner|flag|pennant|sticker|label|notice|menu|map|chart)/i, 'sign'],
  [/(building|house|church|mosque|monastery|palace|castle|dome|barn|lighthouse|dam|viaduct|bridge|pier|dock|patio|gazebo|greenhouse|wall|fence|roof|thatch|tile roof|window|door|stair|pillar|column|arch|triumphal arch|storefront|bookshop|toyshop|bakery|barbershop|butcher shop|shoe shop|confectionery|grocery|tobacco shop|restaurant|theatre|cinema|library|prison|hospital|school|factory|warehouse|servery|boathouse|water tower|gas pump|fountain|parking meter|pay-phone booth|post box|mailbox|birdhouse|bird feeder|birdbath|solar dish|radio telescope|obelisk|totem pole|stone wall|picket fence|chain-link fence|chainlink fence|worm fence|fence)/i, 'building'],
  [/(ball|bat|racket|club|skis|ski|snowboard|surfboard|paddle|canoe|kayak|puck|barbell|dumbbell|trampoline|swing|seesaw|carousel|merry|Ferris wheel|scoreboard|punching bag|gym|treadmill|stairmaster|rowing machine|balance beam|parallel bars|horizontal bar|ski|snorkel|swimming cap|parachute|volleyball|basketball|soccer|football|tennis|badminton|cricket|rugby|golf|hockey|baseball)/i, 'sport'],
  [/(rifle|revolver|cannon|missile|projectile|bomb|bow|crossbow|shield|armour|breastplate|helmet|bulletproof vest|assault)/i, 'weapon'],
  [/(scale|stethoscope|syringe|band aid|mask|oxygen|medicine|thermometer|microscope|petri|beaker|lab coat|crutch|wheelchair)/i, 'medical'],
  [/(piano|guitar|violin|cello|drum|flute|oboe|bassoon|sax|trombone|cornet|harmonica|accordion|banjo|organ|maraca|ocarina|French horn)/i, 'musical'],
  [/(necklace|earring|bracelet|ring|watch|jewellery|tiara|pendant)/i, 'jewellery'],
  [/(soap|shampoo|toothbrush|razor|perfume|towel|comb|hair spray|hair dryer|hair slide|wig|shower cap|bath|toilet|sink|washbasin|mirror|scale|plunger|swab)/i, 'hygiene'],
  [/(pencil|pen|paper|notebook|binder|envelope|book|crayon|chalk|ruler|eraser|folder|stapler|clip|map)/i, 'stationery'],
  [/(doll|teddy|puppet|toy|pinwheel|kite|balloon|puzzle|model|figurine)/i, 'toy'],
  [/(lighter|match|candle|fire|smoke|hazard|axe|knife)/i, 'misc']
];

export function categoryOf(name, fallback = 'misc') {
  const direct = BY_NAME.get(norm(name));
  if (direct) return direct.category;
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Indices
 * ------------------------------------------------------------------ */

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[’‘`]/g, "'")
  .replace(/[^a-z0-9' ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const singular = (s) => {
  if (/(ss|us|is)$/.test(s)) return s;
  if (/ies$/.test(s)) return `${s.slice(0, -3)}y`;
  if (/(ch|sh|x|z|s)es$/.test(s)) return s.slice(0, -2);
  if (/s$/.test(s) && s.length > 3) return s.slice(0, -1);
  return s;
};

export const BY_NAME = new Map();
const BY_ALIAS = new Map();

function indexRecord(rec) {
  const key = norm(rec.name);
  if (!BY_NAME.has(key)) BY_NAME.set(key, rec);
  for (const a of rec.aliases) {
    const k = norm(a);
    if (k && !BY_ALIAS.has(k)) BY_ALIAS.set(k, rec);
  }
}

for (const rec of OBJECTS) indexRecord(rec);

/**
 * Every ImageNet class becomes a KB entry too, so the classifier's 1000-class
 * vocabulary is first-class: it can be spoken, ranged, textured and searched
 * exactly like the curated rows.
 */
export const IMAGENET_KB = IMAGENET_LABELS.map((raw, index) => {
  const label = raw.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const refined = IMAGENET_REFINE[label] || label;
  const base = BY_NAME.get(norm(refined));
  if (base) return { ...base, imagenetIndex: index, imagenetLabel: label, refined: base.name };
  const category = categoryOf(refined, 'misc');
  const rec = {
    name: refined,
    aliases: label !== refined ? [label] : [],
    category,
    materials: [],
    colours: DEFAULT_COLOUR,
    height: 0,
    tier: category === 'animal' || category === 'vehicle' ? 2 : 1,
    tags: [],
    note: '',
    imagenetIndex: index,
    imagenetLabel: label,
    refined
  };
  if (!BY_NAME.has(norm(refined))) BY_NAME.set(norm(refined), rec);
  if (!BY_ALIAS.has(norm(label))) BY_ALIAS.set(norm(label), rec);
  return rec;
});

export const IMAGENET_INDEX = new Map(IMAGENET_KB.map((r) => [r.imagenetIndex, r]));

/** Levenshtein distance capped at 2 — enough to forgive OCR slips, cheap. */
function editDistance(a, b, cap = 2) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * Resolve free text to a KB record. Deliberately forgiving: "socket",
 * "sockets", "plug socket", "power point" and "outlet" all land on one row.
 */
export function lookup(text, { fuzzy = true } = {}) {
  const key = norm(text);
  if (!key) return null;
  if (BY_NAME.has(key)) return BY_NAME.get(key);
  if (BY_ALIAS.has(key)) return BY_ALIAS.get(key);
  const sing = singular(key);
  if (BY_NAME.has(sing)) return BY_NAME.get(sing);
  if (BY_ALIAS.has(sing)) return BY_ALIAS.get(sing);

  // "the red mug", "a pair of scissors" → try the longest known suffix
  const words = key.split(' ');
  for (let start = 0; start < words.length; start++) {
    const slice = words.slice(start).join(' ');
    if (BY_NAME.has(slice)) return BY_NAME.get(slice);
    if (BY_ALIAS.has(slice)) return BY_ALIAS.get(slice);
  }
  if (!fuzzy) return null;
  if (key.length >= 4) {
    for (const [k, rec] of BY_NAME) {
      if (Math.abs(k.length - key.length) <= 2 && editDistance(key, k) <= 1) return rec;
    }
  }
  return null;
}

/** Exact name/alias test (no suffix or fuzzy matching) — for query parsing. */
export function hasExact(term) {
  const key = norm(term);
  if (!key) return false;
  return BY_NAME.has(key) || BY_ALIAS.has(key) || BY_NAME.has(singular(key)) || BY_ALIAS.has(singular(key));
}

export function tierOf(name) {
  const rec = lookup(name, { fuzzy: false });
  if (rec) return rec.tier;
  return categoryOf(name) === 'vehicle' || categoryOf(name) === 'person' ? 3 : 1;
}

export function materialsFor(name) {
  const rec = lookup(name, { fuzzy: false });
  return rec ? rec.materials : [];
}

export function coloursFor(name) {
  const rec = lookup(name, { fuzzy: false });
  return rec ? rec.colours : DEFAULT_COLOUR;
}

export function heightFor(name) {
  const rec = lookup(name, { fuzzy: false });
  return rec ? rec.height : 0;
}

export function noteFor(name) {
  const rec = lookup(name, { fuzzy: false });
  return rec ? rec.note : '';
}

export function tagsFor(name) {
  const rec = lookup(name, { fuzzy: false });
  return rec ? new Set(rec.tags) : new Set();
}

export function categoryLabel(category) {
  return String(category || 'misc').toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Colour naming
 * ------------------------------------------------------------------ */

const COLOUR_LAB = COLOURS.map((row) => {
  const [name, hex, family, note] = row.split('|');
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { name, hex, family: family || 'neutral', note: note || '', rgb: [r, g, b], lab: rgbToLab(r, g, b) };
});

export const NAMED_COLOURS = COLOUR_LAB;

/**
 * Nearest named colour in Lab. `prefer` biases toward an object's own colour
 * priors so a silver kettle does not flip between "silver" and "light grey".
 */
export function nearestColour(lab, { prefer = [], allowMetallic = true } = {}) {
  let best = null; let bestScore = Infinity;
  const preferSet = new Set(prefer.map((p) => norm(p)));
  const METALLIC = new Set(['chrome', 'aluminium', 'titanium', 'silver', 'gold', 'copper', 'brass', 'bronze', 'steel grey', 'pewter', 'gunmetal']);
  for (const c of COLOUR_LAB) {
    if (!allowMetallic && METALLIC.has(c.name)) continue;
    let score = deltaE(lab, c.lab);
    if (preferSet.has(c.name)) score -= 9;                     // prior wins ties
    else if (preferSet.size && preferSet.has(c.family)) score -= 3;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
}

export function colourFamily(lab) {
  return nearestColour(lab)?.family || 'neutral';
}

export function familySwatch(family) {
  return HUE_FAMILIES[family]?.swatch || '#9aa3ab';
}

export { HUE_FAMILIES, LIGHT_TEMPERATURES };

/* ------------------------------------------------------------------ *
 * Brands + signage
 * ------------------------------------------------------------------ */

const BRAND_INDEX = BRANDS.map((row) => {
  const [name, aliases, sector, products, note] = row.split('|').map((s) => (s || '').trim());
  return {
    name,
    aliases: [name, ...(aliases ? aliases.split(',').map((s) => s.trim()) : [])],
    sector,
    products: products ? products.split(',').map((s) => s.trim()) : [],
    note
  };
});

export const BRAND_ROWS = BRAND_INDEX;

/**
 * Match OCR text against the brand lexicon. Short tokens need an exact hit
 * (edit distance turns "can" into "dan"); longer ones tolerate one slip, which
 * is what OCR actually produces.
 */
export function matchBrand(text) {
  const key = norm(text);
  if (!key || key.length < 2) return null;
  let best = null;
  for (const brand of BRAND_INDEX) {
    for (const alias of brand.aliases) {
      const a = norm(alias);
      if (!a) continue;
      if (key === a) return { ...brand, matched: alias, exact: true };
      if (a.length >= 4 && key.includes(a)) return { ...brand, matched: alias, exact: true };
      if (a.length >= 5 && editDistance(key, a) <= 1) {
        if (!best) best = { ...brand, matched: alias, exact: false };
      }
    }
  }
  return best;
}

export function matchSign(text) {
  const key = norm(text);
  if (!key) return null;
  for (const entry of SIGN_LEXICON) {
    for (const w of entry.words) if (key.includes(norm(w))) return { ...entry, matched: w };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

const DISPLAY_OVERRIDES = {
  tv: 'TV', 'cell phone': 'phone', 'wall socket': 'plug socket', 'plug socket': 'plug socket',
  atm: 'cash machine', cd: 'CD', dvd: 'DVD', id: 'ID card'
};

export const displayName = (name) => DISPLAY_OVERRIDES[name] || name;

/**
 * Compose the specific label for an object. Order of authority:
 *   brand text on the object  >  classifier refinement  >  detector class
 * and colour/material only ever qualify, never replace, the noun.
 */
export function nameFor({ cls, refined, brand, colourWord, materialWord, fallback = 'object' } = {}) {
  let noun = refined || cls || fallback;
  const rec = lookup(noun, { fuzzy: false });
  if (rec) noun = rec.name;

  if (brand) {
    const products = brand.products || [];
    const fits = !cls || !products.length || products.some((p) => norm(cls).includes(norm(p)) || norm(p).includes(norm(cls)) || lookup(p)?.category === categoryOf(cls));
    if (fits) {
      const product = products[0] && (norm(cls).includes(norm(products[0])) || norm(products[0]).includes(norm(cls)))
        ? rec?.name || products[0]
        : rec?.name || (categoryOf(cls) === 'device' ? 'device' : noun);
      const has = norm(brand.name).split(' ').some((w) => norm(noun).includes(w));
      return has ? noun : `${brand.name} ${product}`;
    }
  }
  return noun;
}

/* ------------------------------------------------------------------ *
 * Query helpers (used by the agent's natural-language layer)
 * ------------------------------------------------------------------ */

export function searchObjects(term, limit = 12) {
  const key = norm(term);
  if (!key) return [];
  const hits = [];
  for (const rec of BY_NAME.values()) {
    let score = 0;
    const n = norm(rec.name);
    if (n === key) score = 100;
    else if (n.startsWith(key)) score = 80;
    else if (n.includes(key)) score = 60;
    else if (rec.aliases.some((a) => norm(a).includes(key))) score = 50;
    else if (rec.category === key) score = 30;
    else if (rec.materials.some((m) => norm(m).includes(key))) score = 25;
    else if (editDistance(n, key) <= 1 && key.length > 4) score = 20;
    if (score) hits.push({ rec, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.rec);
}

export function stats() {
  return {
    objects: OBJECTS.length,
    aliases: BY_ALIAS.size,
    imagenet: IMAGENET_KB.length,
    materials: MATERIALS.length,
    colours: COLOUR_LAB.length,
    brands: BRAND_INDEX.length,
    conditions: CONDITIONS.length,
    finishes: FINISHES.length,
    vocabulary: BY_NAME.size + BY_ALIAS.size
  };
}

export { MATERIALS, FINISHES, CONDITIONS, SIGN_LEXICON, BRANDS };
