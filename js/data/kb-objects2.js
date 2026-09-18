/**
 * kb-objects.js — ARGUS object knowledge base (part 2 of 2).
 *
 * Same row format as part 1. Together the two tables describe ~800 objects with
 * material priors, colour priors, real-world size (for ranging), interest tier
 * and safety tags. Anything the vision stack can name is resolved against these
 * rows before it is spoken, which is why an EfficientNet guess of "iPod" comes
 * out of the speaker as "phone", and an OCR read of "BOSCH" as "Bosch tool".
 */

export const OBJECTS_2 = `
person|human,man,woman,child,people,pedestrian|person|skin,hair,fabric|skin,colour,dark|1.75|3|private|Pose is estimated per person when the pose module is loaded.
driver|motorist|person|skin,fabric|skin|1.7|3|private
cyclist|bike rider|person|skin,fabric,helmet|colour|1.7|3|
child|kid,boy,girl,toddler|person|skin,fabric|skin|1.2|3|private
baby|infant,pram|person|skin,fabric|skin|0.6|3|private
crowd|group of people,people|person|skin,fabric|colour|1.75|3|private
face|head,visage|person|skin,hair|skin|0.25|3|private|Faces are the highest-sensitivity category — nothing leaves the device.
hair|hairstyle,beard|person|hair|black,brown,blonde,grey|0.2|2|private
hand|hands,palm,fingers|person|skin|skin|0.18|3|private
shoe|footwear|clothing|leather,rubber,fabric|black|0.1|1|
car|motorcar,automobile,vehicle,saloon,estate|vehicle|metal,glass,paint|black,silver,white,blue|1.5|3|vehicle|A car is 4.5 metres long and 1.5 metres tall — that is the ruler in the shot.
van|transit van,panel van|vehicle|metal,glass,paint|white,silver|2.2|3|vehicle
truck|lorry,hgv,tipper|vehicle|metal,glass,paint|white,red,blue|3.2|3|vehicle,hazard|Blind spots run the length of the cab and along both flanks.
pickup truck|pick-up,ute|vehicle|metal,paint|white,silver|1.9|3|vehicle
bus|coach,double decker|vehicle|metal,glass,paint|red,blue,white|3.2|3|vehicle
tram|light rail|vehicle|metal,glass,paint|silver|3.2|2|vehicle
train|locomotive,carriage|vehicle|metal,glass,paint|silver,red|3.8|3|vehicle
motorbike|motorcycle,bike,crotch rocket|vehicle|metal,plastic,paint|black,red,blue|1.1|3|vehicle
scooter|moped,vespa|vehicle|metal,plastic|black,white|1.1|3|vehicle
bicycle|bike,cycle,pushbike|vehicle|metal,rubber,plastic|black,blue,red|1.0|3|vehicle
rickshaw|tuk tuk|vehicle|metal,plastic|green,yellow|1.5|2|vehicle
tractor|farm tractor|vehicle|metal,paint|green,red|2.8|3|vehicle
bulldozer|digger,excavator|vehicle|metal,paint|yellow|3.0|3|vehicle
crane|hoist|vehicle|metal,paint|yellow,red|0|3|hazard
forklift|lift truck|vehicle|metal,paint|yellow,orange|2.2|3|hazard
mixed traffic|traffic,vehicles|vehicle|metal,glass|colour|0|3|vehicle
taxi|cab,hackney|vehicle|metal,glass,paint|black,yellow|1.5|3|vehicle
police car|police cruiser|vehicle|metal,paint|white,blue|1.5|3|vehicle,security
ambulance|paramedic van|vehicle|metal,paint|white,yellow|2.4|3|vehicle,safety
fire engine|fire truck|vehicle|metal,paint|red|3.0|3|vehicle,safety
car wheel|wheel,tyre,tire|vehicle|rubber,metal|black,silver|0.65|2|
tyre|tire,wheel|vehicle|rubber|black|0.65|2|
number plate|licence plate,registration plate|vehicle|metal,plastic|white,yellow|0.1|3|security,private|Plate text is sensitive personal data.
bicycle helmet|cycle helmet|clothing|plastic,foam|white,black|0.25|3|safety
seatbelt|belt|vehicle|fabric,nylon|black|0.3|3|safety
traffic cone|cone,road cone|sign|plastic,rubber|orange|0.5|3|safety
traffic light|signal,stop light|sign|metal,plastic,glass|black|0.9|3|safety
road sign|street sign,traffic sign|sign|metal,plastic|white,red,blue|1.5|3|safety
stop sign|stop|sign|metal|red,white|2.0|3|safety
street name plate|street sign,road name|sign|metal,enamel|white,black|0.25|3|
road markings|line,kerb markings|building|paint|white,yellow|0|2|
kerb|curb,pavement edge|building|concrete,stone|grey|0.15|2|hazard
gutter|drain,gully|fitting|metal,concrete|grey|0.1|1|hazard
manhole cover|drain cover,inspection cover|fitting|metal|grey|0.05|2|hazard
drain|drainage grate|fitting|metal|grey|0.15|2|hygiene
speed bump|hump|building|rubber,concrete|black,yellow|0.1|2|
bollard|post,mooring bollard|fitting|metal,concrete|black,red|0.9|2|hazard
fence|fencing,palisade|building|wood,metal,masonry|brown,grey|1.5|2|
wall panel|fence panel|building|wood|brown|1.8|1|
gate|garden gate|building|metal,wood|black,green|1.8|2|security
door mat|mat,doormat|textile|coir,rubber|brown,black|0.02|1|wet
bin store|refuse store|building|wood,metal|brown,grey|1.5|1|hygiene
lamp post|street light,lamppost|fitting|metal|grey,black|6.0|2|
telegraph pole|utility pole|fitting|wood,metal|brown,grey|8.0|1|
pylon|electricity pylon|fitting|metal|grey|35.0|2|electrical,hazard
power line|overhead line|cable|metal|black|0|1|electrical,hazard
streetlight|street lamp|fitting|metal,glass|grey|6.0|1|
bench|park bench,seat|furniture|wood,metal|wood,black|0.9|2|
picnic table|table|furniture|wood|wood|0.75|1|
barbecue|bbq,grill|appliance|metal|black,silver|0.9|2|hot
awning|canopy,sunshade|building|fabric,metal|colour,striped|2.0|1|
signage|shop sign,hoarding|sign|plastic,metal|colour|1.0|2|
billboard|advertising hoarding|sign|paper,metal|colour|4.0|2|
poster tube|poster|misc|paper|colour|0.6|1|
bus stop|bus shelter,stop|building|metal,glass|grey|2.4|2|
railings|railing,guard rail|building|metal|black,grey|1.1|2|
barrier|traffic barrier,cone|fitting|plastic,metal|red,white|1.0|2|safety
scaffold|scaffolding|building|metal|silver|2.0|2|hazard
skip|dumpster,skip hire|container|metal|yellow,red|1.2|1|
dumpster|skip,bin|container|metal,plastic|green,grey|1.2|1|hygiene
building site|construction site|building|concrete,metal|grey,yellow|0|2|hazard
warehouse|industrial unit|building|metal,concrete|grey|0|1|
shop front|storefront,shop|building|glass,metal|colour|0|2|private
house|home,dwelling,bungalow|building|brick,wood,render|brick,white,grey|0|2|private
flat|apartment,block of flats|building|concrete,brick|grey,brick|0|1|private
office|office building|building|glass,concrete|grey,glass|0|1|
school|academy|building|brick,concrete|brick,grey|0|1|
hospital|clinic,infirmary|building|concrete,glass|white,grey|0|1|
church|chapel,cathedral|building|stone,brick|stone,grey|0|2|
bridge|viaduct|building|concrete,steel|grey|0|1|
tunnel|underpass|building|concrete|grey|0|2|hazard
car park|parking lot,multi-storey|building|concrete,asphalt|grey|0|1|
petrol station|gas station,filling station|building|metal,concrete|white,green|0|3|hazard,flammable|No phones, no naked flame, engine off.
car wash|wash|building|metal,plastic|blue|0|1|wet
shopping trolley|cart,basket|misc|metal,plastic|silver|1.0|2|
shopping basket|basket|container|plastic,wicker|black,colour|0.3|1|
leaflet stand|stand,rack|misc|metal,plastic|black|1.2|1|
vending machine|machine|appliance|metal,glass|colour|1.9|2|electrical
atm|cash machine,hole in the wall|device|metal,plastic|grey,blue|1.6|3|security,valuable|Shield the keypad — shoulder surfing is the oldest trick there is.
cash register|till,pos terminal|device|plastic,metal|black,grey|0.4|2|valuable
card reader|chip and pin,payment terminal|device|plastic|black,grey|0.15|2|security
price tag|label,price|misc|paper,plastic|white|0.05|1|
barcode|barcode label|misc|paper|white|0.03|1|
qr code|qr|misc|paper,plastic|white,black|0.05|2|
till receipt|receipt|misc|paper|white|0.15|1|private
ticket|stub|misc|paper|colour|0.08|1|
boarding pass|pass|misc|paper,phone|white|0.1|1|private
id card|licence,passport,staff card|misc|plastic,paper|colour|0.09|3|private,security
passport|travel document|misc|paper,plastic|red,blue|0.13|3|private,valuable
money|banknote,cash,coin,notes|misc|paper,metal|colour|0.1|3|valuable,private
coin|change,coinage|misc|metal|gold,silver,copper|0.03|2|valuable
bank card|credit card,debit card|misc|plastic|colour|0.09|3|private,valuable
card machine|payment terminal|device|plastic|black|0.15|2|security
bicycle lock|d lock,chain lock|fitting|metal|black,silver|0.2|2|security
wheelie bin|bin,dustbin|container|plastic|green,black|1.1|2|hygiene
fire pit|brazier|misc|metal|black|0.4|2|hot|Cooked embers stay hot for hours under the ash.
chimney|stack,flue|building|brick,metal|brick|0|1|hot
vent|air vent,grille|fitting|metal,plastic|white,grey|0.2|1|
air conditioning unit|ac unit,condenser|appliance|metal,plastic|white,grey|0.6|2|electrical
pipework|pipe,plumbing|fitting|copper,plastic|copper,white|0|1|
water tank|cistern,cylinder|fitting|plastic,metal|white|1.2|1|
solar panel|pv panel|fitting|glass,metal|black,blue|1.7|2|electrical
wind turbine|turbine|building|metal,composite|white|0|2|
satellite dish|dish,aerial|fitting|metal,plastic|grey,white|0.6|1|
aerial|antenna|fitting|metal|silver|0.6|1|
tv aerial|antenna|fitting|metal|silver|0.5|1|
dishwasher tablet|tablet|misc|plastic|colour|0.03|1|hygiene
washing powder|detergent,laundry liquid|hygiene|plastic,card|white,blue|0.3|1|hygiene
bleach|cleaning product|hygiene|plastic|white,blue|0.3|2|hazard|Never mix with acid cleaners — the gas it makes is genuinely dangerous.
laundry basket|hamper|container|fabric,plastic|white,grey|0.4|1|
washing line|clothes line,rotary line|misc|metal,plastic|silver|1.8|1|
peg|clothes peg|misc|plastic,wood|colour,wood|0.08|1|
ironing board|board|furniture|metal,fabric|white,blue|0.9|1|hot
vacuum cleaner|hoover,vacuum|appliance|plastic,metal|grey,red|1.1|2|electrical
mop bucket|bucket|container|plastic|yellow,blue|0.4|2|wet
cleaning trolley|janitor cart|misc|plastic,metal|yellow|1.0|2|wet
wet floor sign|caution sign|sign|plastic|yellow|0.6|3|safety|Slippery until the floor is dry, not until the sign is gone.
ladder rack|rack|misc|metal|silver|0.5|1|
paint|emulsion,gloss,coat|misc|paint|colour|0|1|wet
varnish|wood stain,lacquer|misc|varnish|clear,brown|0|1|wet,flammable
solvent|thinner,white spirit|misc|solvent|clear|0.3|2|hazard,flammable|Vapours are heavier than air and settle in low spaces.
wd40|lubricant,oil spray|misc|oil,aerosol|blue,yellow|0.2|2|flammable
oil|engine oil,motor oil|misc|oil|brown,black|0.3|2|hazard,wet
grease|lubricant|misc|grease|brown,black|0.2|1|wet
lighter|zippo,lighter|misc|metal,plastic|black,silver|0.08|3|hot,flammable
matches|matchbox|misc|wood,card|brown|0.05|3|hot,flammable
firework|firecracker,rocket|misc|paper,cardboard|red,colour|0.2|3|hazard,flammable|Category F3 and above need a licensed operator for a reason.
smoke|steam,vapour|misc|smoke|grey,white|0|3|safety|Uncontrolled smoke means leave by the nearest exit, not the obvious one.
fire|flame,blaze|misc|fire|orange,yellow|0|3|hazard|Flames double in size every thirty seconds given fuel and air.
spill|liquid spill,puddle|misc|liquid|colour|0|3|hazard,wet|Two-thirds of serious falls indoors start on a wet floor.
cracked glass|broken glass,damage|misc|glass|clear|0|3|hazard|Broken glazing fails in shards, not crumbs.
damaged cable|frayed cable,exposed wire|misc|plastic,copper|black,copper|0|3|electrical,hazard|Frayed insulation is the leading cause of appliance fires.
battery|aa battery,lithium battery|device|metal,plastic|silver,black|0.05|3|electrical,hazard|Punctured lithium cells vent and ignite — never crush one.
lithium battery|li-ion,cell|device|metal,plastic|silver|0.05|3|electrical,hazard|A swollen cell is a fire waiting for a reason.
petrol can|jerry can,fuel can|container|metal,plastic|red,green|0.4|3|flammable,hazard
gas cylinder|propane,lpg|container|metal|red,blue,green|0.6|3|flammable,hazard|Valve first, and never indoors.
oxygen cylinder|medical gas|container|metal|white,black|1.4|3|medical,hazard
tool bag|bag|container|fabric|black,red|0.3|1|
first aider|paramedic,medic|person|fabric,skin|green,hi-vis|1.75|3|medical
security guard|guard,officer|person|fabric,skin|black,hi-vis|1.75|2|security
worker|operative,labourer|person|fabric,skin|hi-vis,colour|1.75|2|safety
chef|cook|person|fabric,skin|white,colour|1.75|2|
nurse|clinician|person|fabric,skin|blue,white|1.75|2|medical
police officer|constable,police|person|fabric,skin|black,blue|1.75|3|security
uniform|workwear,scrubs|clothing|fabric|blue,black,white|1.0|1|
lanyard|badge holder|misc|fabric,plastic|colour|0.5|1|security
badge|id badge|misc|plastic|colour|0.08|1|private
dog|puppy,canine|animal|fur|brown,black,white,golden|0.5|3|animal|Ask before touching — not every dog wants the introduction.
cat|kitten,feline|animal|fur|black,white,ginger,grey|0.25|3|animal
puppy|dog|animal|fur|brown,cream|0.3|3|animal
kitten|cat|animal|fur|grey,black|0.2|3|animal
bird|sparrow,pigeon,avian|animal|feather|brown,grey,colour|0.15|3|animal
pigeon|dove|animal|feather|grey|0.3|2|animal
crow|raven,magpie|animal|feather|black|0.4|2|animal
seagull|gull|animal|feather|white,grey|0.4|2|animal
duck|mallard|animal|feather|brown,green|0.25|2|animal
swan|waterfowl|animal|feather|white|0.8|3|animal
hen|chicken,rooster|animal|feather|brown,white|0.4|2|animal
horse|pony,equine|animal|fur,hair|brown,black|1.6|3|animal
cow|cattle,heifer|animal|fur|black,white,brown|1.4|3|animal
sheep|ewe,lamb|animal|wool|white,grey|0.8|3|animal
pig|hog,swine|animal|skin,bristle|pink,black|0.8|3|animal
goat|kid|animal|fur,horn|white,brown|0.7|2|animal
fox|vixen|animal|fur|red,brown|0.4|3|animal
rabbit|bunny,hare|animal|fur|grey,brown,white|0.2|3|animal
squirrel|rodent|animal|fur|red,grey|0.2|2|animal
mouse|rodent|animal|fur|grey,brown|0.05|2|animal
rat|rodent|animal|fur|grey,brown|0.08|2|animal,hygiene
hamster|gerbil|animal|fur|golden,white|0.1|2|animal
snake|serpent,adder|animal|scale|green,brown|0.6|3|animal|Bites are rare, and most bites happen when someone tries to move one.
lizard|gecko,skink|animal|scale|green,brown|0.15|3|animal
frog|toad|animal|skin|green,brown|0.08|2|animal
fish|goldfish,koi|animal|scale|orange,silver|0.1|2|animal
insect|bug,beetle|animal|chitin|black,brown|0.02|2|animal
bee|wasp,bumblebee|animal|chitin|yellow,black|0.02|3|animal,hazard|If you are stung and swell beyond the site, that is an emergency.
spider|arachnid|animal|chitin|black,brown|0.02|2|animal
butterfly|moth|animal|wing|colour|0.05|2|animal
ant|insect|animal|chitin|black,red|0.01|1|animal
worm|earthworm|animal|skin|pink,brown|0.1|1|animal
snail|slug|animal|shell|brown|0.05|1|animal
crab|lobster|animal|shell|red,brown|0.15|3|animal
jellyfish|medusa|animal|gel|clear,blue|0.3|3|animal,hazard|Tentacles sting long after the bell has washed up.
seagull egg|egg|animal|shell|white,beige|0.06|1|animal
birdseed|seed|misc|seed|brown|0.1|1|
cat food|pet food|food|metal,plastic|brown|0.1|1|
dog lead|leash|misc|fabric,leather|black,red|1.0|2|
pet bowl|bowl|misc|ceramic,metal|silver,white|0.06|1|
aquarium|fish tank|misc|glass,plastic|clear|0.4|1|fragile,wet
bird cage|cage|misc|metal|silver|0.5|1|
horse box|trailer|vehicle|metal|silver|2.6|1|vehicle
apple|apples|food|skin|red,green|0.08|2|food
banana|bananas|food|skin|yellow|0.2|2|food
orange|oranges,satsuma|food|skin|orange|0.08|2|food
lemon|lemons|food|skin|yellow|0.08|2|food
lime|limess|food|skin|green|0.05|1|food
pear|pears|food|skin|green,yellow|0.1|2|food
peach|nectarine|food|skin|orange,pink|0.08|1|food
plum|plums|food|skin|purple,red|0.05|1|food
grapes|bunch of grapes|food|skin|green,purple|0.05|2|food
strawberry|strawberries|food|skin|red|0.04|2|food
blueberry|blueberries|food|skin|blue|0.01|1|food
raspberry|raspberries|food|skin|red|0.02|1|food
melon|watermelon|cantaloupe|food|skin|green,orange|0.2|2|food
pineapple|pineapples|food|skin|yellow,brown|0.25|2|food
mango|mangoes|food|skin|orange,green|0.12|2|food
kiwi|kiwifruit|food|skin|brown|0.06|1|food
avocado|avocados|food|skin|green,black|0.1|2|food
tomato|tomatoes|food|skin|red|0.07|2|food
potato|potatoes|food|skin|brown,yellow|0.1|2|food
carrot|carrots|food|root|orange|0.15|2|food
onion|onions|food|skin|brown,red|0.1|2|food
garlic|bulb of garlic|food|skin|white,purple|0.06|2|food
pepper|bell pepper,capsicum|food|skin|red,green,yellow|0.1|2|food
chilli|chili,chile|food|skin|red,green|0.08|2|food|Capsaicin is oil-soluble: water spreads it, milk lifts it.
cucumber|cucumbers|food|skin|green|0.2|1|food
lettuce|salad leaves|food|leaf|green|0.15|1|food
broccoli|calabrese|food|stem|green|0.15|1|food
cabbage|greens|food|leaf|green|0.2|1|food
cauliflower|brassica|food|floret|white|0.2|1|food
mushroom|mushrooms|food|flesh|brown,white|0.08|2|food
sweetcorn|corn|food|kernel|yellow|0.2|1|food
peas|green peas|food|seed|green|0.05|1|food
beans|green beans|food|pod|green|0.15|1|food
rice|rice grains|food|grain|white,brown|0.05|1|food
pasta|spaghetti,penne|food|grain|yellow|0.05|1|food
bread|loaf,sliced bread|food|bread|brown,white|0.15|2|food
toast|sliced bread|food|bread|brown|0.1|1|food
bagel|roll|food|bread|brown|0.1|1|food
croissant|pastry|food|pastry|golden|0.1|1|food
cake|birthday cake,gâteau|food|sponge,icing|colour,chocolate|0.15|2|food
cupcake|fairy cake|food|sponge,icing|colour|0.08|1|food
biscuit|cookie|food|biscuit|brown|0.05|1|food
doughnut|donut|food|dough|colour|0.08|1|food
chocolate|bar|food|cocoa|brown|0.15|1|food
sweets|candy,boiled sweets|food|sugar|colour|0.05|1|food
ice cream|gelato,ice lolly|food|cream|white,colour|0.1|1|food
crisps|chips,snacks|food|foil,plastic|colour|0.25|1|food
sandwich|butty,sub|food|bread|colour|0.1|1|food
burger|hamburger|food|bread,meat|brown|0.1|1|food
pizza|pizzas|food|dough,cheese|colour|0.03|2|food|hot
chips|fries|food|potato|golden|0.1|1|food|hot
egg|eggs|food|shell|white,brown|0.06|2|food
cheese|cheddar|food|cheese|yellow,white|0.08|1|food
milk|milk carton|food|plastic,card|white|0.25|2|food
butter|margarine|food|wrap|yellow|0.12|1|food
yogurt|yoghurt|food|plastic|white|0.12|1|food
meat|joint of meat|food|meat|red,pink|0.2|2|food|raw
chicken|poultry|food|meat|pink|0.25|2|food|raw
fish fillet|fish|food|meat|white,pink|0.2|1|food|raw
sausage|sausages|food|meat|brown|0.12|1|food
bacon|rashers|food|meat|pink,red|0.2|1|food
flour|bag of flour|food|paper|white|0.3|1|food
sugar|bag of sugar|food|paper|white|0.25|1|food
cereal|cereal box|food|card|colour|0.3|1|food
soup|soup tin|food|metal|red,orange|0.1|1|food|hot
coffee|cup of coffee|food|ceramic,glass|brown,black|0.1|2|hot
tea|cup of tea|food|ceramic|brown|0.1|2|hot
beer|pint,lager|food|glass,aluminium|amber,gold|0.16|2|alcohol
wine|glass of wine|food|glass|red,white|0.2|2|alcohol
spirits|whisky,vodka,gin|food|glass|clear,amber|0.25|2|alcohol
soft drink|fizzy drink,soda|food|plastic,metal|colour|0.25|1|food
water bottle|bottle of water|food|plastic|clear|0.25|1|food
juice|carton of juice|food|card,plastic|orange|0.25|1|food
menu|bill of fare|misc|paper,plastic|white|0.3|1|food
cutlery set|knife fork spoon|kitchen|metal|silver|0.25|2|
napkin|serviette|misc|paper,fabric|white|0.15|1|
tablecloth|cloth|textile|fabric|white,colour|0.02|1|
picnic|picnic blanket|misc|fabric,food|colour|0.02|1|
lunch box|lunchbox,tupperware|container|plastic|colour|0.2|1|food
flask|thermos|container|metal,plastic|silver,black|0.25|1|hot
cool box|cooler,esky|container|plastic|blue,white|0.4|1|
ice|ice cubes|misc|ice|clear,white|0.03|1|
popcorn|popcorn bag|food|card|white,yellow|0.2|1|food
fast food wrapper|wrapper|misc|paper|colour|0.1|1|hygiene
disposable cup|paper cup|container|paper,plastic|white,brown|0.12|1|
straw|drinking straw|misc|plastic,paper|white,colour|0.2|1|
teabag|tea bag|food|paper|brown|0.05|1|food
finger food|nibbles|food|food|colour|0.05|1|food
herbs|seasoning|food|leaf|green|0.15|1|food
spice jar|spice|food|glass|colour|0.1|1|food
condiment|sauce,ketchup|food|plastic,glass|red,yellow|0.15|1|food
salt|pepper|food|glass,plastic|white,black|0.1|1|food
football|soccer ball|sport|leather,rubber|white,black|0.22|3|sport
basketball|ball|sport|leather,rubber|orange|0.24|2|sport
tennis ball|ball|sport|rubber,felt|yellow|0.07|2|sport
cricket ball|ball|sport|leather|red,white|0.07|2|sport
rugby ball|ball|sport|leather|brown|0.25|2|sport
golf ball|ball|sport|rubber|white|0.04|1|sport
table tennis bat|ping pong bat,racket|sport|wood,rubber|red,black|0.15|2|sport
tennis racket|racket|sport|metal,fabric,wood|black,colour|0.7|2|sport
badminton racket|racket|sport|metal,fabric|black|0.7|2|sport
cricket bat|bat|sport|wood|wood|0.9|2|sport
baseball bat|bat|sport|wood,metal|wood|0.85|2|sport
hockey stick|stick|sport|wood,composite|black|1.0|2|sport
golf club|club,driver|sport|metal|silver|1.1|2|sport
skateboard|board|sport|wood,metal|colour|0.8|3|sport
skateboard helmet|helmet|sport|plastic,foam|black|0.25|2|safety
surfboard|board|sport|foam,resin|white,colour|1.8|2|sport
paddleboard|sup|sport|foam|colour|3.0|1|sport
kayak|canoe|sport|plastic|colour|0.6|2|sport
paddle|oar|sport|plastic,wood|colour|1.5|1|sport
life jacket|buoyancy aid|sport|fabric,foam|orange,yellow|0.5|3|safety
life ring|lifebuoy|misc|rubber|orange,white|0.7|3|safety
swimming goggles|goggles|sport|plastic,silicone|clear,black|0.06|1|sport
dumbbell|weight,free weight|sport|metal,rubber|black,silver|0.3|2|sport
barbell|weight bar|sport|metal|silver|0.3|2|sport
kettlebell|weight|sport|metal,cast iron|black|0.3|2|sport
yoga mat|exercise mat|sport|foam,rubber|purple,blue|0.01|1|sport
resistance band|exercise band|sport|rubber|colour|0.05|1|sport
boxing gloves|gloves|sport|leather,foam|red,black|0.3|2|sport
running shoes|trainers|sport|mesh,rubber|colour|0.12|2|sport
trophy|cup,award|misc|metal,plastic|gold,silver|0.3|1|
medal|award|misc|metal,fabric|gold,silver,bronze|0.1|2|
scoreboard|score board|misc|metal,plastic|black|1.0|1|
goal post|goal|sport|metal,plastic|white|2.4|1|sport
netball hoop|hoop|sport|metal|white|3.0|1|sport
skipping rope|rope|sport|plastic,rope|colour|0.2|1|sport
frisbee|disc|sport|plastic|colour|0.03|1|sport
kite|kite|sport|fabric,plastic|colour|0.5|1|sport
tent peg|peg|sport|metal|silver|0.2|1|sport
fishing rod|rod|sport|composite,metal|black|2.0|2|sport|sharp
fishing net|net|sport|mesh,metal|green|1.0|1|sport
guitar|acoustic guitar,electric guitar|musical|wood,metal|brown,black,red|1.0|2|valuable
bass guitar|bass|musical|wood,metal|black,sunburst|1.1|2|valuable
violin|fiddle|musical|wood|brown|0.6|2|valuable,fragile
cello|'cello|musical|wood|brown|1.2|2|valuable,fragile
piano|keyboard,upright piano,grand|musical|wood,plastic|black,white|1.2|2|valuable
electronic keyboard|synth,synthesiser|musical|plastic|black|0.15|2|
drum kit|drums|musical|wood,metal,plastic|colour,black|1.0|2|
drum|snare,bongo|musical|wood,metal|white,wood|0.4|2|
flute|piccolo|musical|metal|silver|0.6|1|
trumpet|brass instrument|musical|brass|gold,silver|0.5|2|
saxophone|sax|musical|brass|gold|1.0|2|
clarinet|woodwind|musical|wood,plastic|black|0.7|2|
harmonica|mouth organ|musical|metal,plastic|silver|0.1|1|
ukulele|uke|musical|wood|brown|0.5|1|
accordion|squeeze box|musical|wood,metal|red,black|0.4|1|
music stand|stand|musical|metal|black|1.2|1|
microphone stand|stand|musical|metal|black|1.5|1|
amplifier|amp|musical|metal,plastic|black|0.4|2|electrical
dj deck|turntable,cdj|musical|plastic,metal|black|0.2|2|valuable
speaker stack|pa system|musical|wood,plastic|black|1.5|2|
metronome|tick|musical|plastic,wood|black|0.2|1|
sheet music|music|musical|paper|white|0.3|1|
art easel|easel|misc|wood,metal|wood|1.6|1|
canvas|painting|misc|canvas,wood|white,colour|0.6|1|
palette|paint palette|misc|wood,plastic|brown|0.3|1|wet
paint pots|paints|misc|plastic|colour|0.1|1|wet
sketchbook|drawing book|stationery|paper|white|0.3|1|
pottery|ceramics|misc|clay,ceramic|terracotta|0.3|1|fragile
clay|pottery clay|misc|clay|grey,brown|0.2|1|
sewing kit|needle and thread|misc|metal,fabric|silver,colour|0.15|1|sharp
needle|sewing needle|misc|metal|silver|0.05|3|sharp
thread|cotton|textile|cotton|colour|0.05|1|
knitting|knitting needles,wool|textile|wool,metal|colour|0.3|1|
yarn|wool|misc|wool|colour|0.2|1|
fabric|cloth,textile,material|textile|fabric,cotton|colour,pattern|0.5|1|
leather|hide|textile|leather|brown,black|0.3|2|
denim|jean fabric|textile|denim|blue|0.3|1|
silk|satin|textile|silk|colour|0.3|1|
velvet|velour|textile|velvet|red,blue|0.3|1|
linen|hemp|textile|linen|beige,white|0.3|1|
wool|fleece|textile|wool|grey,cream|0.3|1|
nylon|synthetic fabric|textile|nylon|colour|0.3|1|
polyester|synthetic|textile|polyester|colour|0.3|1|
canvas bag|tote bag|misc|canvas,fabric|beige,colour|0.4|2|
cardboard tube|tube|misc|cardboard|brown|0.5|1|
bubble wrap|packaging|misc|plastic|clear|0.5|1|
packing tape|tape|misc|plastic|clear,brown|0.1|1|
pallet truck|pump truck|tool|metal|yellow,silver|1.2|2|hazard
hand truck|sack barrow,trolley|tool|metal|silver|1.2|2|
trolley jack|jack|tool|metal|red|0.4|2|hazard
car jack|scissor jack|tool|metal|silver|0.3|2|hazard
jump leads|jumper cables|tool|copper,rubber|black,red|0.5|2|electrical,hazard|Wrong polarity on a jump start destroys the alternator instantly.
spanner set|socket set|tool|metal|silver|0.3|2|valuable
socket wrench|ratchet|tool|metal|silver,black|0.3|2|
allen key|hex key|tool|metal|silver|0.1|1|
spirit level|level|tool|metal,plastic|yellow|0.6|1|
chisel|wood chisel|tool|metal,wood|silver,wood|0.2|2|sharp
plane|wood plane|tool|metal,wood|silver,wood|0.25|2|sharp
vice|vise,bench vice|tool|metal|blue,silver|0.25|1|
clamp|g clamp|tool|metal|silver|0.2|1|
workbench|bench|furniture|wood,metal|brown|0.9|2|
tool chest|chest|container|metal|red|0.8|1|
nail gun|staple gun|tool|metal,plastic|yellow|0.3|3|sharp,hazard
welding mask|welder|tool|plastic,glass|black|0.3|3|safety
welder|arc welder|tool|metal,plastic|black,red|0.4|3|electrical,hazard
multimeter|tester,voltmeter|tool|plastic,rubber|yellow,black|0.2|2|electrical
voltage tester|tester|tool|plastic|yellow|0.15|2|electrical
inspection lamp|work light|tool|metal,glass|yellow,black|0.3|2|hot,electrical
generator|genny|tool|metal,plastic|red,black|0.6|2|electrical,hazard
air compressor|compressor|tool|metal|blue,red|0.6|2|hazard
pressure washer|jet washer|tool|plastic,metal|blue,yellow|1.0|2|electrical,wet
extension reel|extension cable|tool|plastic|orange,black|0.3|2|electrical
hand dryer|electric dryer|appliance|plastic,metal|white,grey|0.3|1|hot,electrical
paper towel dispenser|dispenser|fitting|plastic,metal|white,grey|0.4|1|
water cooler|drinking fountain|appliance|plastic,metal|white,blue|1.4|1|
coffee machine|vending machine|appliance|metal,plastic|black,steel|0.5|2|hot,electrical
microwave|microwave|appliance|metal,glass|white|0.3|2|hot,electrical
fridge|refrigerator|appliance|metal,plastic|white,steel|1.8|2|electrical
chest freezer|freezer|appliance|metal,plastic|white|1.0|1|electrical
shelf|shelving,rack|furniture|wood,metal|white,wood|1.8|2|
shelving unit|shelves|furniture|metal,wood|grey,wood|1.8|1|
rack|storage rack|furniture|metal|grey,silver|1.8|1|
desk|table,workstation|furniture|wood,metal,laminate|wood,white,grey|0.75|3|
office chair|chair,swivel chair|furniture|plastic,fabric,metal|black,grey|0.9|2|
chair|seat,stool|furniture|wood,plastic,metal|wood,black,grey|0.9|2|
armchair|chair|furniture|fabric,leather,wood|grey,beige,black|0.8|2|
sofa|couch,settee|furniture|fabric,leather|grey,beige,black|0.8|2|
deck chair|sun lounger|furniture|fabric,metal|striped|0.7|1|
stool|bar stool|furniture|wood,metal|wood,black|0.7|2|
table|dining table,desk|furniture|wood,glass,metal|wood,white|0.75|3|
coffee table|table|furniture|wood,glass|wood,glass|0.45|1|
sideboard|dresser|cabinet|furniture|wood|wood,white|0.85|1|
wardrobe|closet,armoire|furniture|wood,mdf|white,wood|2.0|2|
chest of drawers|dresser,drawers|furniture|wood,mdf|white,wood|0.9|1|
bed|double bed,single bed|furniture|wood,fabric,metal|white,wood,grey|0.6|3|
bunk bed|bed|furniture|metal,wood|silver,wood|1.6|1|
mattress|bed|furniture|fabric,foam|white|0.25|2|
cot|crib|furniture|wood,metal|white|0.9|2|private
bookcase|bookshelf,shelves|furniture|wood,mdf|wood,white|1.8|2|
cabinet|cupboard|furniture|wood,mdf,metal|white,wood|0.9|2|
cupboard|wardrobe,cabinet|furniture|wood,mdf|white,wood|1.5|2|
kitchen unit|kitchen cabinet|furniture|wood,mdf|white,grey,wood|0.9|1|
worktop|countertop,counter|furniture|stone,laminate,wood|black,grey,wood|0.05|2|
sink unit|kitchen sink|fitting|ceramic,metal|steel,white|0.3|2|wet
tap|faucet,mixer tap|fitting|metal,chrome|chrome|0.2|2|wet
drainer|dish rack|kitchen|metal,plastic|silver|0.15|1|wet
tea towel|dishtowel|textile|fabric|colour|0.5|1|wet
oven glove|mitt|textile|fabric|black,red|0.35|2|hot
trivet|pot stand|kitchen|metal,wood|black|0.05|1|hot
kitchen scales|scales|kitchen|plastic,metal|white,silver|0.15|1|
measuring jug|jug|kitchen|glass,plastic|clear|0.2|1|
mixing bowl|bowl|kitchen|metal,ceramic|silver,white|0.12|1|
sieve|strainer|kitchen|mesh,metal|silver|0.2|1|
pickle jar|jar|food|glass|green|0.15|1|fragile
wine rack|rack|furniture|wood,metal|wood|0.8|1|alcohol
bar|pub,counter|furniture|wood,metal|wood|1.1|1|alcohol
drink|glass of drink,beverage|food|glass|colour|0.15|1|food
cocktail|cocktail glass|food|glass|colour|0.18|1|alcohol
shot glass|glass|food|glass|clear|0.08|1|alcohol
tub|bath|fitting|plastic,ceramic|white|0.5|1|wet
bidet|toilet|fitting|ceramic|white|0.4|1|hygiene
towel radiator|rail|fitting|metal|chrome|0.8|1|hot
hand dryer|dryer|appliance|metal,plastic|steel|0.3|1|hot,electrical
sanitary bin|bin|container|metal,plastic|white|0.6|1|hygiene
nappy bin|bin|container|plastic|white|0.5|1|hygiene
first aid room|medical room|building|plaster|white|0|1|medical
notice board|bulletin board|furniture|cork,wood|brown|0.6|1|
clocking in machine|time clock|device|plastic,metal|grey|0.3|1|
printer|laser printer|device|plastic,metal|black,white|0.3|2|electrical
paper tray|tray|misc|plastic|grey|0.3|1|
shredder|paper shredder|device|plastic,metal|black,grey|0.4|2|sharp
photocopier|copier,multifunction printer|device|plastic,metal|grey,white|1.0|2|electrical
laminator|device|device|plastic,metal|white|0.2|1|
whiteboard marker|marker|stationery|plastic|black,colour|0.14|1|
clock|wall clock|misc|plastic,metal|white|0.3|2|
fire door|door|building|wood,metal|grey,white|2.0|3|safety|Fire doors must never be wedged — that is what they are for.
fire extinguisher point|extinguisher|fitting|metal|red|0.5|3|safety
fire blanket|blanket|safety|fabric|white,red|0.3|3|safety
escape ladder|fire escape|ladder|metal|grey|3.0|3|safety
assembly point sign|muster point|sign|metal,plastic|green,white|1.0|3|safety
gas shut off valve|isolation valve|fitting|metal,brass|yellow|0.15|3|gas,safety|Know this valve before you need this valve.
electrical panel|distribution board|fitting|metal,plastic|grey|0.6|3|electrical
utility room|laundry room|building|plaster,tile|white|0|1|
boiler room|plant room|building|metal,concrete|grey|0|2|hazard
server rack|rack,comms cabinet|device|metal|black,grey|2.0|2|electrical,valuable
network switch|switch,router|device|metal,plastic|black,grey|0.05|2|electrical
router|hub,modem|device|plastic|black,white|0.06|2|electrical
patch panel|cabinet|device|metal|black|0.2|1|
cable tray|trunking|cable|metal,plastic|silver,white|0|1|
data centre|server room|building|metal,plastic|black|0|1|valuable
battery bank|ups,battery cabinet|device|metal|black,grey|1.0|2|electrical
inverter|power inverter|device|metal|silver|0.2|2|electrical
charging station|ev charger|device|plastic,metal|white,green|1.2|2|electrical
plug |socket|fitting|plastic,metal|white|0.05|2|electrical
light|lighting,lamp|fitting|glass,plastic|white|0.2|2|
ceiling fan|fan|appliance|metal,plastic|white,wood|0.4|1|electrical
air vent|grille,vent|fitting|metal,plastic|white|0.3|1|
radiator cover|cabinet|furniture|wood,mdf|white|0.7|1|hot
blackboard|chalkboard|stationery|wood,slate|black|1.0|1|
chalk|chalk stick|stationery|chalk|white,colour|0.08|1|
projector|beamer|device|plastic,glass|white,black|0.1|2|electrical
projection screen|screen|misc|fabric,metal|white|2.0|1|
lectern|podium|furniture|wood|brown|1.1|1|
tripod|stand|device|metal,plastic|black,silver|0.6|2|
camera bag|bag|misc|fabric|black|0.3|1|valuable
drone battery|battery|device|plastic|black|0.1|1|electrical,hazard
sd card|memory card|device|plastic,metal|black|0.03|1|valuable
usb stick|flash drive,thumb drive|device|plastic,metal|black,silver|0.05|2|valuable
external hard drive|hard disk,ssd|device|metal,plastic|black,silver|0.12|2|valuable,private
ssd|solid state drive|device|metal,plastic|black|0.07|1|valuable
router aerial|antenna|device|plastic|black|0.2|1|
sim card|sim|device|plastic,metal|white|0.02|1|private
battery charger|charger|device|plastic|black|0.1|1|electrical
phone case|case,cover|device|plastic,silicone,leather|black,clear,colour|0.15|1|
screen protector|protector|device|glass,plastic|clear|0.15|1|fragile
laptop stand|riser|device|metal,plastic|silver|0.15|1|
docking station|dock|device|metal,plastic|black,silver|0.1|1|electrical
mouse mat|desk mat|device|fabric,rubber|black|0.03|1|
monitor stand|stand|device|metal,plastic|black,silver|0.2|1|
tv stand|unit|furniture|wood,glass|black,wood|0.5|1|
soundbar|speaker|device|plastic,fabric|black|0.1|1|
games console|playstation,xbox|device|plastic|white,black|0.1|2|valuable
vr headset|headset,quest|device|plastic,fabric|white,black|0.2|2|valuable,private
smart speaker|alexa,echo,homepod|device|fabric,plastic|grey,white|0.15|2|private
smart thermostat|thermostat,heating control|device|plastic,glass|white|0.1|2|
smart doorbell|doorbell|device|plastic,glass|black,white|0.1|2|security,private
smart plug|plug adapter|device|plastic|white|0.06|2|electrical
smart bulb|bulb|device|plastic,glass|white|0.1|1|electrical
wearable|fitness tracker,smartwatch|device|metal,plastic,silicone|black,silver|0.04|3|valuable,private
action camera|gopro|camera|device|plastic,glass|black|0.07|2|valuable
gimbal|stabiliser|device|plastic,metal|black|0.3|1|valuable
selfie stick|monopod|device|metal,plastic|black|0.5|1|
ring light|light|device|plastic,glass|white|0.3|1|electrical
green screen|chroma key|misc|fabric,metal|green|2.0|1|
tripod head|head|device|metal|black|0.15|1|
light meter|meter|device|plastic|black|0.1|1|
megaphone|loudhailer|device|plastic|red,yellow|0.4|2|
radio|fm radio,dab radio|device|plastic,metal|black,silver|0.2|2|
walkie talkie|two way radio|device|plastic|black|0.2|2|
cb radio|radio|device|plastic,metal|black|0.15|1|
turntable|record player,deck|device|plastic,metal,wood|black|0.2|2|valuable
vinyl record|record,lp|misc|vinyl,card|black|0.31|2|valuable
cd|disc,compact disc|misc|plastic|silver|0.12|1|
dvd|disc,blu-ray|misc|plastic|silver|0.12|1|
vhs tape|video tape|misc|plastic|black|0.2|1|
cassette|tape|misc|plastic|black|0.1|1|
camera lens|optic lens|device|glass,plastic,metal|black|0.1|3|valuable,fragile
binoculars|binos|device|plastic,glass|black|0.15|3|valuable
telescope|scope|device|metal,glass|black,silver|1.2|2|valuable
microscope|scope|device|metal,glass|black,silver|0.4|2|fragile,valuable
test tube|tube|medical|glass|clear|0.15|2|fragile,medical
petri dish|dish|medical|glass,plastic|clear|0.02|1|medical
beaker|flask|medical|glass|clear|0.12|1|fragile
pipette|dropper|medical|plastic,glass|clear|0.3|1|fragile
centrifuge|lab equipment|medical|metal,plastic|grey,white|0.4|1|medical
lab coat|coat|medical|fabric|white|0.9|2|medical
microscope slide|slide|medical|glass|clear|0.08|1|fragile
fume cupboard|fume hood|medical|metal,glass|grey|0.9|2|hazard
gas tap|bunsen burner tap|fitting|metal|brass|0.15|2|gas,safety
bunsen burner|burner|medical|metal|silver|0.2|2|hot,gas
safety shower|eyewash station|fitting|metal,plastic|green,steel|2.0|3|safety
first aid box|kit|medical|plastic,metal|green,white|0.25|3|medical
sharps bin|clinical waste bin|medical|plastic|yellow|0.3|3|medical,biohazard|Yellow means clinical waste — nothing goes in it except sharps.
trolley|hospital trolley,cart|medical|metal,plastic|silver|1.0|2|medical
hospital bed|bed|medical|metal,plastic|white,blue|0.9|2|medical
iv stand|drip stand|medical|metal|silver|1.8|3|medical
bedpan|pan|medical|metal,plastic|steel|0.1|1|hygiene
blood sample bag|blood bag|medical|plastic|red|0.2|3|medical,biohazard
medicine trolley|drug trolley|medical|metal,plastic|silver|1.0|3|medical,private
thermometer|temperature probe|medical|plastic|white|0.15|2|medical
pulse oximeter|oximeter|medical|plastic|blue,grey|0.08|2|medical
glucometer|blood glucose meter|medical|plastic|grey|0.1|2|medical
nebuliser|nebulizer|medical|plastic|white|0.2|1|medical
ecg machine|ekg|medical|plastic,metal|white,grey|0.3|2|medical
x-ray|radiograph|medical|film,paper|grey|0.4|2|medical,private
scan|ct scan,mri|medical|metal,plastic|white|2.0|1|medical
sling|arm sling|medical|fabric|white|0.4|1|medical
compression bandage|bandage|medical|fabric|beige|0.2|1|medical
hearing aid|aid|medical|plastic|beige|0.04|2|medical
spectacles|glasses|medical|plastic,glass|black|0.05|3|medical,private
contact lens|lens|medical|plastic|clear|0.014|1|medical
medicine|tablets,pills|medical|plastic,foil|white,colour|0.1|3|medical
ointment|cream|medical|tube|white|0.15|1|medical
antiseptic|disinfectant|medical|plastic|clear,blue|0.25|2|medical
plaster cast|cast|medical|plaster|white|0.3|2|medical
ice pack|cold pack|medical|plastic,gel|blue|0.2|2|medical
hot water bottle|hottle|medical|rubber|red,grey|0.3|2|hot
sunscreen|sun cream|hygiene|plastic|white,yellow|0.2|1|hygiene
insect repellent|repellent|hygiene|aerosol,plastic|green|0.2|1|hygiene
lip balm|lip salve|hygiene|plastic|white|0.08|1|
perfume|aftershave|hygiene|glass,plastic|colour,clear|0.12|2|valuable
makeup|cosmetics,foundation|hygiene|plastic,glass|beige,colour|0.1|2|private
nail varnish|polish|hygiene|glass|colour|0.08|1|hazard,flammable
hair straightener|straighteners,tongs|hygiene|plastic,metal|black,pink|0.3|2|hot|Metal plates hold heat for minutes after the light goes off.
curling wand|tongs|hygiene|plastic,metal|black|0.3|1|hot
clippers|hair clippers|hygiene|plastic,metal|black|0.2|1|sharp
nail clippers|clippers|hygiene|metal|silver|0.08|1|sharp
tweezers|tweezer|hygiene|metal|silver|0.1|1|sharp
cotton bud|cotton swab|hygiene|plastic,cotton|white|0.08|1|hygiene
makeup brush|brush|hygiene|fabric,plastic|black,colour|0.2|1|
mirror|compact mirror|hygiene|glass,plastic|silver|0.1|1|fragile
scales|bathroom scales|hygiene|plastic,glass|white,black|0.05|1|
razor blade|blade|hygiene|metal|silver|0.03|3|sharp
shaving brush|brush|hygiene|wood,bristle|wood|0.15|1|
hot tub|jacuzzi|misc|plastic,wood|blue,beige|0.9|1|wet
pool|swimming pool|building|tile,water|blue|0|2|wet,hazard|Drowning is silent — a body in water makes almost no noise.
pond|water feature|building|stone,water|green,blue|0|2|wet
fountain|water feature|building|stone,metal|grey|0|1|wet
`;
