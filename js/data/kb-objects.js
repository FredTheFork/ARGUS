/**
 * kb-objects.js — ARGUS object knowledge base (part 1 of 2).
 *
 * Every row is one recognisable thing, written in a deliberately dense pipe
 * format so that ~800 fully-described objects stay readable in source form:
 *
 *   name | aliases | category | materials | colours | height_m | tier | tags | note
 *
 *   name       canonical label spoken by the assistant ("wall socket")
 *   aliases    comma list the recogniser/queries may match instead
 *   category   colour + register grouping (see CATEGORIES in config.js)
 *   materials  most likely first — seeds the material scorer, best guess wins
 *   colours    most common finishes first — seeds the colour describer
 *   height_m   real-world height in metres, used for the monocular range
 *              solver. 0 means "no useful prior, do not print a distance".
 *   tier       3 = call out on sight, 2 = mention, 1 = log quietly
 *   tags       comma list: hazard, electrical, hot, sharp, fragile, valuable,
 *              food, wet, biohazard, security, brandy, medical, private
 *   note       optional one-line advisory that may be spoken verbatim
 *
 * A row may omit trailing fields; the parser fills the defaults.
 */

export const OBJECTS_1 = `
phone|iphone,mobile,smartphone,mobile phone,cellphone,cell phone,handset|device|glass,aluminium,plastic|black,white,silver,blue|0.15|3|valuable,private|Screen-lit rectangles are the most common object in view.
laptop|notebook computer,macbook,computer|device|aluminium,plastic,glass|silver,black,grey|0.02|3|valuable|Measured across the lid when closed, not the screen diagonal.
tablet|ipad,slate|device|glass,aluminium|black,silver|0.02|3|valuable
desktop computer|pc,tower,workstation|device|metal,plastic|black,grey|0.4|2|valuable
monitor|screen,display,computer monitor|device|plastic,glass,metal|black,grey|0.4|2|
television|tv,telly,flat screen|device|plastic,glass|black|0.6|3|electrical
keyboard|computer keyboard|device|plastic,metal|black,grey,white|0.02|2|
mouse|computer mouse|device|plastic|black,grey,white|0.04|2|
trackpad|touchpad|device|glass,plastic|grey,black|0.01|1|
printer|inkjet,laser printer|device|plastic,metal|white,black,grey|0.3|2|electrical
scanner|flatbed scanner|device|plastic,glass|grey,black|0.1|1|electrical
speaker|bluetooth speaker,audio speaker,monitor speaker|device|plastic,wood,metal|black,grey,white|0.2|2|
headphones|headphone,over-ear,cans|device|plastic,leather,metal|black,white|0.2|2|private
earbuds|airpods,earphones,in-ear|device|plastic,silicone|white,black|0.03|2|private
microphone|mic|device|metal,plastic|black,silver|0.2|2|
camera|dslr,mirrorless,camcorder|device|plastic,metal,glass|black|0.1|3|private,valuable
webcam|camera module,web camera|device|plastic,glass|black|0.05|2|private
game console|playstation,xbox,nintendo,console|device|plastic,metal|black,white|0.1|2|valuable
games controller|gamepad,joypad,controller|device|plastic|black,white|0.15|2|
remote control|remote,clicker|device|plastic|black,silver|0.02|2|
drone|quadcopter,uav|device|plastic,composite|grey,black,white|0.1|3|valuable
power bank|battery pack,portable charger|device|aluminium,plastic|black,silver|0.1|2|electrical,valuable
charger|power adapter,brick,usb charger|device|plastic|white,black|0.07|2|electrical
cable|lead,wire,cord,usb cable|device|plastic,rubber|black,white|0.005|1|electrical
power strip|extension lead,surge protector|fitting|plastic,metal|white,black|0.03|2|electrical
wall socket|plug socket,power socket,power point,outlet,electrical outlet,wall plug|fitting|plastic,metal|white,ivory,beige|0.086|3|electrical,hazard|Live conductors behind the faceplate — never probe it.
light switch|switch,wall switch|fitting|plastic,metal|white,ivory,black|0.086|2|electrical
socket faceplate|faceplate,cover plate|fitting|plastic|white,ivory|0.086|1|electrical
circuit breaker|breaker,fuse box,consumer unit,distribution board|fitting|plastic,metal|grey,white|0.3|3|electrical,hazard|Isolate at the main switch before touching any circuit.
plug|power plug,mains plug|fitting|plastic,metal|black,white|0.05|2|electrical,hazard|Metal pins are live when inserted — hold by the body only.
usb port|port,connector socket|fitting|metal,plastic|silver,black|0.01|2|electrical
light bulb|bulb,lamp bulb,globe|fitting|glass,metal|white,clear|0.11|2|fragile,hot|Old filament bulbs stay hot long after they go dark.
lamp|table lamp,desk lamp,bedside lamp|furniture|metal,fabric,glass|white,beige,black|0.4|2|hot
lampshade|shade,light shade|furniture|fabric,paper,metal|white,cream|0.25|1|
ceiling light|light fitting,pendant|fitting|metal,plastic,glass|white,chrome|0.2|2|electrical
chandelier|pendant light|fitting|glass,metal,crystal|clear,gold|0.6|2|fragile
led strip|light strip|fitting|plastic|white,colour|0.01|1|electrical
torch|flashlight|tool|metal,plastic|black,silver|0.15|3|electrical
candle|candle stick|misc|wax,glass|cream,white|0.15|2|hot|Open flame — keep clear of fabric and paper.
power tool|drill,angle grinder,sander,circular saw|tool|plastic,metal|yellow,black,green|0.25|3|sharp,hazard|Rotating parts and no guard on the off-hand — keep hands behind the line.
power drill|drill,driver|tool|plastic,metal|black,yellow,blue|0.22|3|sharp,electrical
angle grinder|grinder,disc cutter|tool|metal,plastic|black,orange|0.2|3|sharp,hazard
screwdriver|driver,phillips,flathead|tool|metal,plastic|red,black,chrome|0.2|3|sharp,valuable
hammer|claw hammer|tool|metal,wood,fibreglass|black,wood|0.3|3|sharp
wrench|spanner,adjustable spanner|tool|metal|chrome,black|0.25|2|valuable
pliers|pincers,side cutters|tool|metal,plastic|red,chrome|0.18|3|sharp
saw|hand saw,panel saw|tool|metal,wood,plastic|silver,blue|0.4|3|sharp,hazard
tape measure|measure,measuring tape|tool|metal,plastic|yellow,black|0.08|2|
level|spirit level|tool|metal,plastic|yellow,silver|0.5|1|
utility knife|stanley knife,box cutter,craft knife|tool|metal,plastic|yellow,black|0.15|3|sharp,hazard|Retract the blade before it leaves your hand.
scissors|shears,snips|tool|metal,plastic|silver,red|0.2|3|sharp
nail file|emery board|hygiene|metal,plastic|grey|0.1|1|sharp
screw|fixing,bolt|fitting|metal|silver,gold|0.01|1|sharp
nail|round nail|fitting|metal|silver|0.05|1|sharp
nut and bolt|fastener|fitting|metal|silver|0.02|1|
drill bit|bit|tool|metal|silver,black|0.05|2|sharp
sandpaper|abrasive paper|tool|paper,abrasive|brown,grey|0.15|1|
paint brush|brush,decorating brush|tool|wood,bristle,metal|wood,white|0.2|2|wet
paint roller|roller|tool|plastic,fabric|white,yellow|0.2|2|wet
paint tin|paint can,pot of paint|container|metal,plastic|white,colour|0.18|2|wet,hazard
ladder|step ladder,extension ladder|tool|aluminium,wood,fibreglass|silver,grey|1.8|3|hazard|Never the top step — a third of ladder falls happen there.
toolbox|tool bag,chest|container|plastic,metal|red,black,grey|0.25|2|
wheelbarrow|barrow|tool|metal,plastic|grey|0.6|1|hazard
lawn mower|mower|tool|metal,plastic|green,red|0.9|2|sharp,hazard
hedge trimmer|strimmer,line trimmer|tool|plastic,metal|green,orange|1.0|2|sharp,hazard
garden hose|hose,hosepipe|tool|rubber,plastic|green,grey|0.2|1|wet
watering can|watering pot|container|plastic,metal|green,grey|0.3|1|wet
grill|barbecue,bbq|appliance|metal|black,silver|0.9|2|hot,hazard
kettle|electric kettle|appliance|plastic,metal,glass|black,white,steel|0.25|2|hot,electrical
toaster|toaster oven|appliance|metal,plastic|silver,black|0.2|2|hot,electrical
microwave|microwave oven|appliance|metal,glass|black,white,silver|0.3|2|electrical,hot
oven|cooker,range|appliance|metal,enamel,glass|steel,black,white|0.9|2|hot,hazard
hob|stove top,cooktop|appliance|glass,metal|black|0.05|2|hot,hazard|Residual heat: the ring stays hot after the light goes out.
refrigerator|fridge,frigidaire|appliance|metal,plastic|white,steel,silver|1.8|2|electrical
freezer|chest freezer|appliance|metal,plastic|white|1.2|1|electrical
dishwasher|dish washer|appliance|metal,plastic|steel,white|0.85|1|electrical,wet
washing machine|washer,laundry machine|appliance|metal,glass,plastic|white,silver|0.85|2|electrical,wet
tumble dryer|dryer,clothes dryer|appliance|metal,plastic|white|0.85|1|electrical,hot
vacuum|hoover,vacuum cleaner|appliance|plastic,metal|grey,red,blue|1.1|2|electrical
espresso machine|coffee machine,coffee maker|appliance|metal,plastic|steel,black|0.35|2|hot,electrical
coffee grinder|grinder,mill|appliance|metal,plastic|black,silver|0.2|1|electrical
blender|liquidiser,mixer|appliance|glass,plastic,metal|clear,black|0.4|2|sharp,electrical
food processor|processor|appliance|plastic,metal|white,black|0.4|2|sharp,electrical
toaster|pop-up toaster|appliance|metal,plastic|silver,black|0.2|2|hot
rice cooker|cooker|appliance|plastic,metal|white,silver|0.3|1|hot,electrical
air fryer|fryer|appliance|plastic,metal|black,silver|0.35|1|hot,electrical
slow cooker|crock pot|appliance|ceramic,metal|white,black|0.25|1|hot,electrical
iron|clothes iron,steam iron|appliance|plastic,metal|blue,white,black|0.15|2|hot|The soleplate holds enough heat to mark skin minutes after use.
hair dryer|hairdryer,blow dryer|appliance|plastic|black,pink,white|0.25|2|hot,electrical
electric fan|fan,desk fan|appliance|plastic,metal|white,black|0.35|2|sharp,electrical
space heater|heater,radiator|appliance|metal,plastic|white,black|0.5|3|hot,hazard|Never behind a curtain — that is how heater fires start.
humidifier|dehumidifier|appliance|plastic|white,grey|0.3|1|electrical,wet
air purifier|purifier|appliance|plastic,metal|white,grey|0.6|1|electrical
sewing machine|sewer|appliance|metal,plastic|white,black|0.3|2|sharp
smoke detector|smoke alarm|fitting|plastic|white|0.04|3|safety|If it is chirping, the battery is the message.
carbon monoxide alarm|co detector|fitting|plastic|white|0.1|3|safety
fire extinguisher|extinguisher|fitment|metal,plastic|red|0.5|3|safety|Check the gauge before you need it, not after.
fire alarm call point|break glass point|fitting|plastic,glass|red|0.12|3|safety
emergency exit sign|fire exit,running man sign|sign|plastic|green,white|0.3|3|safety
first aid kit|medical kit|medical|plastic,fabric|white,green,red|0.25|3|medical
defibrillator|aed|medical|plastic,metal|green,yellow|0.3|3|medical
cctv camera|security camera,surveillance camera|fitting|plastic,metal|white,grey|0.2|3|private,security
alarm keypad|security panel|fitting|plastic|white,grey|0.15|2|security
door lock|lock,deadbolt,yale lock|fitting|metal,brass|brass,chrome,silver|0.1|2|security
padlock|combination lock|fitting|metal|silver,brass,black|0.08|2|security
key|keys,door key|misc|metal|silver,brass|0.06|3|security,valuable
keyring|key chain|misc|metal,plastic|silver|0.05|1|
door handle|handle,knob|fitting|metal,plastic,brass|chrome,brass,white|0.15|2|
door|front door,back door,fire door|building|wood,metal,glass|white,wood,brown|2.0|2|
window|glazing,pane|building|glass,wood,plastic|clear,white|1.2|2|fragile
window blind|blind,venetian blind|textile|fabric,plastic,metal|white,grey|1.5|1|
curtain|drape,curtains|textile|fabric|beige,grey,colour|2.0|1|
radiator|central heating radiator|fitting|metal|white,grey|0.6|2|hot|Surface is hot enough to redden skin — do not lean on it.
thermostat|heating control|fitting|plastic,glass|white|0.1|2|
boiler|combi boiler,water heater|appliance|metal,plastic|white|1.0|2|hot,gas
gas meter|electricity meter,meter|fitting|metal,plastic|grey,white|0.3|2|safety
radiator valve|trv|fitting|metal,plastic|white,chrome|0.08|1|hot
floor|floorboards,tiles,laminate|building|wood,tile,concrete,stone|carpet,brown,grey,beige|0|1|
ceiling|roof,soffit|building|plaster,concrete|white,cream|0|1|
wall|partition,brickwork|building|plaster,brick,concrete|white,cream,brick|0|1|
skirting board|baseboard|building|wood,mdf|white,wood|0.12|1|
staircase|stairs,steps|building|wood,stone,carpet|wood,grey|0|2|hazard
banister|handrail,railing|building|wood,metal|wood,white|0.9|2|safety
carpet|rug,mat|textile|fabric|beige,grey,pattern|0.01|1|
rug|mat,carpet|textile|fabric|pattern,beige|0.01|1|
tile|wall tile,floor tile,ceramic tile|building|ceramic,stone,porcelain|white,grey,beige|0.2|1|
tiles|tiling,ceramics|building|ceramic,porcelain,stone|white,beige,blue|0|1|
mirror|looking glass|furniture|glass,metal|silver|0.8|2|fragile
picture frame|frame,photograph,photo frame|furniture|wood,metal,glass|black,wood,gold|0.3|1|
painting|art,canvas,poster|misc|canvas,paper,wood|colour|0.5|2|
poster|print,picture|misc|paper|colour|0.6|1|
poster board|noticeboard,bulletin board|furniture|wood,cork,paper|wood,colour|0.6|1|
whiteboard|dry wipe board|stationery|plastic,metal|white|1.0|2|
notice|poster,leaflet|misc|paper|white,colour|0.3|1|
clock|wall clock,analog clock|misc|plastic,metal,glass|white,black|0.3|2|
wall clock|clock|misc|plastic,metal,glass|white,black|0.35|2|
watch|wristwatch,smartwatch,timepiece|jewellery|metal,glass,leather|silver,black,gold|0.04|3|valuable
bracelet|bangle,wristband|jewellery|metal,leather,beads|gold,silver,colour|0.05|2|valuable
ring|band,jewellery ring|jewellery|metal,stone|gold,silver|0.02|3|valuable
necklace|chain,pendant|jewellery|metal,stone|gold,silver|0.2|2|valuable
earring|stud,earrings|jewellery|metal,stone|gold,silver|0.02|2|valuable
sunglasses|shades,sunnies|clothing|plastic,glass,metal|black,tortoise|0.06|3|valuable,private
glasses|spectacles,eyeglasses,spectacle|clothing|plastic,glass,metal|black,metal,tortoise|0.05|3|private,valuable
wallet|billfold,purse|misc|leather,fabric|black,brown|0.1|3|valuable,private
handbag|bag,purse,tote|misc|leather,fabric|black,brown,beige|0.25|3|valuable,private
backpack|rucksack,bag,daypack|misc|fabric,canvas,nylon|black,grey,blue|0.45|3|valuable
suitcase|case,trunk,luggage|misc|plastic,fabric,aluminium|black,grey|0.6|3|valuable
briefcase|attaché case|misc|leather,metal|brown,black|0.3|2|valuable
umbrella|brolly,parasol|misc|fabric,plastic,metal|black,colour|0.9|2|
coat|jacket,overcoat,parka|clothing|fabric,wool,nylon|black,navy,grey|0.9|2|
jacket|coat,blazer|clothing|fabric,leather,nylon|black,blue,olive|0.7|2|
hoodie|sweatshirt,jumper|clothing|fabric,cotton|grey,black,colour|0.7|2|
jumper|sweater,pullover,knitwear|clothing|wool,cotton,fabric|grey,blue,red|0.65|2|
t-shirt|tee,top,shirt|clothing|cotton,fabric|white,black,colour|0.6|2|
shirt|blouse,dress shirt|clothing|cotton,fabric|white,blue,pattern|0.7|2|
dress|frock,gown|clothing|fabric,cotton,silk|colour,black,red|1.1|2|
trousers|pants,slacks|clothing|fabric,denim,wool|black,blue,grey|1.0|2|
jeans|denim,denims|clothing|denim|blue,black|1.0|2|
skirt|frock|clothing|fabric|black,colour|0.5|2|
shorts|short trousers|clothing|fabric,cotton|black,blue,grey|0.4|1|
socks|sock,stocking|clothing|cotton,fabric|white,black,grey|0.2|1|
shoes|shoe,trainers,sneakers,footwear|clothing|leather,fabric,rubber|black,white,brown|0.1|2|
boots|boot,wellies|clothing|leather,rubber|brown,black|0.25|2|
trainers|sneakers,running shoes,sneaker|clothing|fabric,rubber,mesh|white,black,colour|0.12|3|
slippers|house shoes|clothing|fabric,fur|grey,beige|0.08|1|
hat|cap,beanie,baseball cap|clothing|fabric,wool,cotton|black,blue,colour|0.15|2|
scarf|muffler|clothing|wool,fabric|red,pattern|0.9|1|
gloves|glove,mitten|clothing|leather,fabric,rubber|black,brown|0.2|1|
belt|waist belt|clothing|leather,fabric|black,brown|0.9|1|
tie|necktie|clothing|silk,fabric|red,blue,pattern|0.5|2|
handkerchief|hankie|textile|fabric,cotton|white|0.2|1|hygiene
towel|bath towel,tea towel|textile|cotton,fabric|white,blue,grey|0.7|1|wet
bedding|duvet,quilt,comforter,blanket|textile|fabric,cotton|white,grey,pattern|0.5|1|
pillow|cushion|textile|fabric,cotton|white,beige|0.5|1|
duvet|quilt,comforter|textile|fabric,cotton|white,pattern|0.5|1|
sleeping bag|bivvy bag|textile|fabric,nylon|green,blue|0.3|1|
tent|pup tent,dome tent|misc|nylon,fabric|green,orange|1.2|2|
camping stove|gas burner|tool|metal|grey|0.15|2|hot,gas|Gas canisters: check the seal and never inside a tent.
torch light|flashlight|tool|metal,plastic|black|0.2|3|electrical
water bottle|bottle,drinks bottle,flask|container|plastic,metal,glass|clear,blue,steel|0.25|2|
bottle|drinks bottle,glass bottle|container|glass,plastic|clear,green,brown|0.28|2|fragile
wine bottle|bottle of wine|container|glass|green,brown,clear|0.3|2|fragile,alcohol
can|tin,drinks can,coke can|container|aluminium,metal|red,silver,colour|0.12|2|
tin|food tin,canned food|container|metal|silver|0.1|2|
jar|glass jar,preserve jar|container|glass,metal|clear|0.15|2|fragile
mug|cup,coffee mug,tea cup|kitchen|ceramic,porcelain|white,colour|0.1|2|hot
cup|mug,teacup|kitchen|ceramic,porcelain,glass|white,colour|0.09|2|hot
glass|drinking glass,tumbler|kitchen|glass|clear|0.15|2|fragile
wine glass|goblet,glass|kitchen|glass|clear|0.2|2|fragile,alcohol
pint glass|beer glass|kitchen|glass|clear|0.16|2|fragile,alcohol
bottle opener|opener|kitchen|metal|silver,black|0.15|2|sharp
corkscrew|opener|kitchen|metal,plastic|silver,black|0.15|2|sharp,alcohol
plate|dinner plate,dishes|kitchen|ceramic,porcelain|white,pattern|0.03|2|fragile
bowl|basin,dish|kitchen|ceramic,porcelain,plastic|white,colour|0.08|2|fragile
teapot|pot|kitchen|ceramic,porcelain|white,pattern|0.15|2|hot
frying pan|pan,skillet|kitchen|metal,nonstick|black,silver|0.05|2|hot
saucepan|pot,pan|kitchen|metal,stainless|silver|0.15|2|hot
wok|pan|kitchen|metal,carbon steel|black,silver|0.12|2|hot
baking tray|sheet pan,tin|kitchen|metal|silver,dark|0.03|1|hot
chopping board|cutting board|kitchen|wood,plastic|wood,white|0.03|2|sharp
knife|kitchen knife,blade,chef knife|kitchen|metal,steel|silver,black|0.25|3|sharp,hazard|Treat every knife as loaded — point down, edge away.
paring knife|knife|kitchen|metal,steel|silver|0.2|3|sharp
fork|cutlery|kitchen|metal,stainless|silver|0.2|2|sharp
spoon|cutlery,teaspoon|kitchen|metal,stainless|silver|0.19|2|
teaspoon|spoon|kitchen|metal|silver|0.15|2|
chopsticks|sticks|kitchen|wood,bamboo,plastic|wood,black|0.25|2|
ladle|spoon,serving spoon|kitchen|metal,plastic|silver|0.3|1|
spatula|turner,fish slice|kitchen|plastic,metal,wood|black,silver|0.3|2|hot
whisk|balloon whisk|kitchen|metal|silver|0.28|1|
grater|cheese grater|kitchen|metal,plastic|silver|0.25|1|sharp
colander|strainer,sieve|kitchen|metal,plastic|silver|0.2|1|
peeler|potato peeler|kitchen|metal|silver|0.18|1|sharp
rolling pin|pin|kitchen|wood,marble|wood|0.4|1|
kettle|electric kettle|appliance|plastic,metal|black,silver|0.25|2|hot
microwave oven|microwave|appliance|metal,glass|black,white|0.3|2|hot,electrical
kitchen roll|paper towel|misc|paper|white|0.25|1|
tin foil|aluminium foil|misc|metal,aluminium|silver|0.3|1|
cling film|plastic wrap|misc|plastic|clear|0.3|1|
food bag|sandwich bag|misc|plastic|clear|0.2|1|
salt shaker|salt cellar|kitchen|glass,ceramic|clear,white|0.1|1|
pepper mill|pepper grinder|kitchen|wood,metal|wood,black|0.2|1|
sugar bowl|bowl|kitchen|ceramic|white|0.1|1|
bread bin|bread box|container|metal,wood|white,silver|0.35|1|
fridge magnet|magnet|misc|plastic|colour|0.05|1|
bin|trash can,waste bin,rubbish bin,dustbin|container|plastic,metal|grey,black|1.0|2|hygiene
bin bag|trash bag,rubbish bag|misc|plastic|black|0.5|1|hygiene
recycling bin|recycle bin|container|plastic,metal|blue,green|1.0|1|
compost bin|food waste caddy|container|plastic|brown,green|0.4|1|hygiene
dustpan|dust pan|tool|plastic,metal|grey,red|0.3|1|hygiene
brush|broom,scrubbing brush|tool|plastic,wood,bristle|blue,wood|0.9|2|hygiene
mop|floor mop|tool|plastic,fabric,wood|blue,grey|1.2|2|wet,hygiene
bucket|pail|container|plastic,metal|blue,white|0.3|2|wet
sponge|cleaning sponge|misc|foam|yellow,blue|0.1|1|wet
disposable glove|rubber glove|misc|rubber,latex|blue,yellow|0.25|1|wet,hygiene
soap|bar of soap,hand soap|hygiene|soap|white,colour|0.09|2|hygiene
soap dispenser|soap pump|hygiene|plastic,glass,metal|white,grey|0.18|2|hygiene
shampoo|shampoo bottle,conditioner|hygiene|plastic|colour,white|0.2|2|hygiene
toothbrush|brush|hygiene|plastic,nylon|colour,white|0.2|2|hygiene
toothpaste|paste|hygiene|plastic|white,blue|0.18|1|hygiene
deodorant|antiperspirant|hygiene|plastic,metal|white,colour|0.15|1|hygiene
razor|shaving razor|hygiene|plastic,metal|blue,silver|0.15|2|sharp
shaving foam|shaving cream|hygiene|metal,plastic|white,blue|0.2|1|
hairbrush|comb|hygiene|plastic,wood|black,wood|0.25|1|
hair clip|hair slide,barrette|hygiene|plastic,metal|black,brown|0.08|1|
plaster|band aid,bandage|medical|fabric,plastic|beige,white|0.07|2|medical
bandage|dressing,gauze|medical|fabric,cotton|white,beige|0.1|2|medical
syringe|needle,injection|medical|plastic,metal|clear,silver|0.15|3|sharp,medical,biohazard|Sharps: never re-cap a needle by hand.
pill bottle|medicine bottle,tablets|medical|plastic|white,amber|0.12|3|medical|Check the label and the date before anything else.
blister pack|pill packet,tablets|medical|plastic,foil|silver,white|0.1|2|medical
thermometer|clinical thermometer|medical|plastic,glass|white|0.15|2|medical
stethoscope|stethoscope|medical|metal,rubber|black,silver|0.5|3|medical
blood pressure monitor|sphygmomanometer|medical|plastic,fabric|white,grey|0.15|2|medical
inhaler|puffer|medical|plastic|blue,grey|0.1|2|medical
crutch|walking aid|medical|metal,plastic|silver,grey|1.2|2|medical
wheelchair|chair|medical|metal,fabric|black,silver|1.0|3|medical
oxygen mask|mask|medical|plastic,rubber|clear,green|0.15|3|medical
face mask|surgical mask,dust mask|medical|fabric,paper|white,blue|0.1|3|medical,hygiene
protective goggles|safety glasses,eye protection|medical|plastic,glass|clear,yellow|0.08|3|safety
ear defenders|ear muffs,hearing protection|medical|plastic,foam|yellow,black|0.15|3|safety
hard hat|helmet,bump cap|medical|plastic|yellow,white|0.25|3|safety
hi-vis vest|high visibility jacket,safety vest|clothing|fabric,mesh|yellow,orange|0.6|3|safety
ruler|rule,straight edge|stationery|plastic,metal,wood|clear,silver|0.3|1|
pencil|pencil|stationery|wood,graphite|yellow,grey|0.18|1|
pen|ballpoint,biro,fountain pen|stationery|plastic,metal|black,blue|0.15|2|
marker|felt tip,permanent marker|stationery|plastic|black,colour|0.14|1|
highlighter|marker pen|stationery|plastic|yellow,pink|0.14|1|
eraser|rubber|stationery|rubber|white,pink|0.05|1|
sharpener|pencil sharpener|stationery|plastic,metal|clear,silver|0.03|1|sharp
notebook|pad,notepad,exercise book|stationery|paper,card|white,colour|0.2|2|
book|paperback,hardback,volume|misc|paper,card|colour|0.2|3|
magazine|periodical|misc|paper|colour|0.28|1|
newspaper|paper,news|misc|paper|grey|0.3|1|
envelope|letter|stationery|paper|white,brown|0.11|1|
folder|binder,ring binder|stationery|card,plastic|colour|0.3|1|
stapler|stapler|stationery|metal,plastic|black,silver|0.15|1|sharp
hole punch|puncher|stationery|metal|black,silver|0.15|2|
sticky notes|post-it,notes|stationery|paper|yellow,pink|0.07|1|
tape|sellotape,scotch tape|stationery|plastic|clear|0.05|1|
glue stick|glue,adhesive|stationery|plastic|white|0.1|1|
cardboard box|box,carton|container|cardboard,paper|brown|0.4|2|
plastic bag|carrier bag|container|plastic|white,colour|0.3|1|hygiene
crate|crate|container|plastic,wood|black,blue|0.3|1|
pallet|wooden pallet|container|wood|wood|0.15|1|
crate of bottles|bottles|container|glass,plastic|clear|0.3|1|fragile
shoe box|box|container|cardboard|colour|0.12|1|
gift wrap|wrapping paper,present|misc|paper|colour|0.3|1|
candle holder|holder|misc|metal,glass,ceramic|silver,clear|0.15|1|hot
ornament|figurine,decoration|misc|ceramic,glass,resin|colour|0.2|1|fragile
vase|flower vase|misc|ceramic,glass|white,clear|0.3|2|fragile
houseplant|plant,potted plant,pot plant|plant|ceramic,soil,leaf|green|0.4|2|
plant pot|flowerpot,pot|plant|ceramic,plastic,terracotta|terracotta,white|0.2|1|
flower|bloom,flowers|plant|petal,stem|colour|0.3|3|
tree|sapling|plant|wood,leaf|green,brown|0|2|
shrub|bush,hedge|plant|leaf,wood|green|0|1|
grass|lawn,turf|plant|grass|green|0|1|
moss|lichen|plant|moss|green|0.02|1|
succulent|cactus|plant|ceramic,leaf|green|0.15|2|
herb|basil,parsley,herbs|plant|leaf|green|0.2|1|food
flower pot|planter|plant|ceramic,plastic|terracotta|0.2|1|
soil|compost,dirt,earth|misc|soil|brown,black|0|1|
leaf|leaves,foliage|plant|leaf|green,brown|0.1|1|
branch|twig,bough|plant|wood|brown|0|1|
log|firewood,timber|misc|wood|brown|0.3|1|
rock|stone,boulder,pebble|misc|stone,granite|grey,brown|0.3|1|
sand|gravel|misc|sand|beige|0|1|
water|puddle,pool,liquid|misc|water|clear,blue|0|2|wet
cardboard|card|misc|cardboard|brown|0|1|
plastic sheet|polythene,sheeting|misc|plastic|clear,black|0|1|
metal sheet|steel plate,panel|misc|metal,steel|silver|0|1|
wood|timber,board,plank|misc|wood|brown|0|1|
glass pane|glass sheet|misc|glass|clear|0|1|fragile
brick|breeze block|misc|brick|red,brown|0.07|1|
concrete block|block|cinder block|misc|concrete|grey|0.2|1|
cable reel|drum|misc|plastic,metal|black|0.4|1|
pipe|plumbing pipe,tube|fitting|metal,copper,plastic|copper,white|0|2|
valve|tap valve|fitting|metal,brass|brass|0.1|2|
tap|faucet,water tap|fitting|metal,chrome|chrome,silver|0.15|2|wet
sink|basin,wash basin|fitting|ceramic,metal|white,steel|0.2|2|wet
toilet|loo,wc|fitting|ceramic,plastic|white|0.7|2|hygiene
shower|shower head,shower unit|fitting|metal,plastic|chrome,white|2.0|2|wet
bath|bathtub|fitting|ceramic,acrylic|white|0.6|2|wet
urinal|toilet|fitting|ceramic|white|0.9|2|hygiene
towel rail|radiator,towel radiator|fitting|metal,chrome|chrome,white|0.8|1|
bathroom mirror cabinet|cabinet|furniture|glass,wood|white,wood|0.7|1|
shower gel|body wash|hygiene|plastic|colour|0.2|1|hygiene
toilet roll|toilet paper|hygiene|paper|white|0.1|2|hygiene
air freshener|freshener|hygiene|plastic,metal|colour|0.15|1|
bin liner|bin bag|misc|plastic|black|0.4|1|hygiene
`;
