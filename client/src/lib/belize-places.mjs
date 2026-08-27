// Shared by the React component and the server. Keep one copy.
// Locality -> district. Matched as substrings, so keep entries >= 4 chars
// and specific enough not to collide with street names.

export const DISTRICTS = ["Corozal", "Orange Walk", "Belize", "Cayo", "Stann Creek", "Toledo"];

export const TOWNS = {
  Corozal: ["corozal town", "corozal", "sarteneja", "consejo", "copper bank", "chunox", "progresso", "libertad", "san joaquin", "ranchito", "xaibe", "calcutta", "louisville", "patchakan", "chula vista", "joseito", "san narciso", "paraiso", "san pedro corozal", "buena vista corozal", "concepcion", "san victor", "santa clara corozal"],
  "Orange Walk": ["orange walk town", "orange walk", "guinea grass", "san estevan", "trial farm", "august pine ridge", "blue creek", "shipyard", "indian church", "yo creek", "san felipe", "carmelita", "san lazaro", "trinidad", "san jose palmar", "douglas village", "chan pine ridge", "san antonio orange walk", "santa martha orange walk", "tower hill"],
  Belize: ["belize city", "ladyville", "hattieville", "hattiville", "burrell boom", "bermudian landing", "crooked tree", "sand hill", "lords bank", "lord's bank", "san pedro town", "ambergris", "caye caulker", "gales point", "biscayne", "maskall", "rancho dolores", "mahogany heights", "la democracia", "belama", "bomba", "belize district", "buttonwood bay", "vista del mar", "lake independence", "kings park", "belize rural"],
  Cayo: ["belmopan", "san ignacio", "santa elena", "benque", "spanish lookout", "roaring creek", "camalote", "teakettle", "unitedville", "united ville", "bullet tree", "georgeville", "blackman eddy", "valley of peace", "esperanza", "cotton tree", "armenia", "succotz", "more tomorrow", "duck run", "salvapan", "piccini", "bradleys bank", "bradley's bank", "bradelys bank", "st. matthews", "ontario village", "cayo district", "santa familia", "billy white", "calla creek", "san jose cayo", "las flores", "maya mopan belmopan"],
  "Stann Creek": ["dangriga", "placencia", "seine bight", "independence village", "independence", "santa rosa", "sarawee", "hopkins", "sittee", "mango creek", "maya beach", "pomona", "silk grass", "georgetown", "red bank", "middlesex", "kingsville", "steadfast", "riversdale", "cocoplum", "maya king", "santa cruz", "hummingbird community", "st. margaret", "santa marta", "alta vista", "san roman", "cow pen", "wagierale", "stann creek", "plantation", "forest lagoon", "surfside", "maya mopan", "san pablo", "sarawee", "commerce bight", "melinda"],
  Toledo: ["punta gorda", "big falls", "san antonio toledo", "san pedro columbia", "silver creek", "golden stream", "indian creek", "medina bank", "forest home", "jacintoville", "san isidro", "swasey", "monkey river", "barranco", "cattlelanding", "cattle landing", "toledo", "bella vista", "trio village", "trio", "san pablo road", "bladen", "santa rosa toledo", "dump toledo", "eldridge ville", "mafredi"],
};

export const norm = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// "cayo district", "stann creek", "toledo" etc. name a DISTRICT, not a town.
// They must never win town resolution or Belmopan addresses come back as
// town="cayo district". Kept out of the town candidate pool entirely.
const DISTRICT_MARKERS = new Set(
  DISTRICTS.flatMap((d) => [norm(d), `${norm(d)} district`])
);

const ALL_TOWNS = Object.entries(TOWNS)
  .flatMap(([d, ts]) => ts.map((t) => [norm(t), d]))
  .filter(([t]) => !DISTRICT_MARKERS.has(t));

/**
 * Resolve free-text address -> { town, district }.
 *
 * District comes from an explicit "<X> District", else a bare district name,
 * else whichever district the resolved town belongs to.
 * Town is the longest matching locality, so "San Antonio Toledo" beats
 * "San Antonio" and "Belmopan" beats "Bladen" in "5 Bladen Street, Belmopan".
 */
export function placeOf(text) {
  const t = ` ${norm(text)} `;
  let district = null;
  for (const d of DISTRICTS) {
    if (t.includes(` ${norm(d)} district `)) { district = d; break; }
  }
  if (!district) {
    for (const d of DISTRICTS) {
      if (t.includes(` ${norm(d)} `)) { district = d; break; }
    }
  }
  const hits = ALL_TOWNS.filter(([town]) => t.includes(town));
  if (!hits.length) return { town: null, district };
  const [town, td] = hits.reduce((a, b) => (b[0].length > a[0].length ? b : a));
  return { town, district: district || td };
}

/** Name variants for joining schedule names to roster names. */
export function nameKeys(s) {
  const t = norm(s).split(" ").filter(Boolean);
  const out = new Set([t.join(" ")]);
  if (t.length >= 2) {
    out.add(`${t[0]} ${t[t.length - 1]}`);
    out.add(`${t[0]} ${t[1]}`);
  }
  return [...out];
}

/** Coordinates for the towns staff live in — used for weather lookups. */
export const TOWN_COORDS = {
  "belize city": [17.498, -88.188], belmopan: [17.251, -88.767],
  "corozal town": [18.396, -88.388], benque: [17.076, -89.139],
  "san ignacio": [17.157, -89.070], "santa elena": [17.162, -89.055],
  "bradleys bank": [17.162, -89.055], dangriga: [16.970, -88.233],
  ladyville: [17.567, -88.302], hattieville: [17.446, -88.412],
  hattiville: [17.446, -88.412], "orange walk town": [18.081, -88.560],
  libertad: [18.293, -88.464], belama: [17.510, -88.213],
  "burrell boom": [17.564, -88.404], pomona: [16.986, -88.335],
  "trial farm": [18.096, -88.554], "united ville": [17.144, -89.006],
  unitedville: [17.144, -89.006], esperanza: [17.140, -89.020],
  "roaring creek": [17.246, -88.802], camalote: [17.216, -88.860],
  "san narciso": [18.283, -88.505], salvapan: [17.256, -88.783],
  piccini: [17.245, -88.775], "yo creek": [18.083, -88.606],
  "san jose palmar": [18.093, -88.567], bomba: [17.688, -88.316],
  cattlelanding: [16.130, -88.803], "punta gorda": [16.099, -88.809],
  ranchito: [18.363, -88.404], "chula vista": [18.390, -88.400],
  joseito: [18.396, -88.388], "blue creek": [17.900, -88.980],
  "lords bank": [17.545, -88.310], "lord's bank": [17.545, -88.310],
  "bradelys bank": [17.162, -89.055], "bradley's bank": [17.162, -89.055],
  wagierale: [16.970, -88.233], sarawee: [16.983, -88.245],
  "san antonio toledo": [16.258, -88.976], "big falls": [16.284, -88.799],
};
