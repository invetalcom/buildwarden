const LANDING_PAGE_JOKES: Record<string, string> = {
  darkMode: "Why do programmers prefer dark mode? Because light attracts bugs.",
  sqlBar: "A SQL query walks into a bar, walks up to two tables, and asks: can I join you?",
  stackOverflow: "What do you call a programmer who does not use Stack Overflow? A very confident liar.",
  javaGlasses: "Why do Java developers wear glasses? Because they do not C#.",
  recursion: "To understand recursion, you must first understand recursion.",
  cacheMoney: "There are only two hard things in computer science: cache invalidation, naming things, and off-by-one errors.",
  zeroIndex: "Real programmers start counting at zero and still somehow end up one short.",
  freezeException: "My computer does not hate winter, it just keeps throwing freeze exceptions.",
  nationalAnthem: "\"It works on my machine\" remains the unofficial anthem of software development.",
  detective: "Debugging is detective work where the detective and the culprit share the same keyboard.",
  semicolon: "Semicolons have ended more relationships than distance ever could.",
  loopBar: "A loop walks into a bar and never reaches the exit condition.",
  branchOut: "Why do developers like trees? Plenty of branches and very little management.",
  noHardware: "How many programmers change a lightbulb? None, that ticket belongs to hardware.",
  googling: "Programming is 10 percent writing code and 90 percent searching for why it broke.",
  cloud: "The cloud is just somebody else's computer with a nicer pricing page.",
  cacheBroke: "Why did the developer go broke? They spent all their cache.",
  restLife: "Why was the app developer so calm? They were living a RESTful life.",
  binaryNovel: "I started writing a novel in binary, but critics say the plot is too one-zero-one-zero.",
  bugNature: "Programmers do not hate nature, they just dislike the bug density.",
  cleanCode: "I tried to write clean code, but the deadline preferred spaghetti.",
  versionOne: "If it fails the first time, rename it version 1.0 and keep moving.",
  gitFixedStuff: "git commit -m \"fixed stuff\" is developer shorthand for \"brace for impact.\"",
  consoleBug: "How do you comfort a JavaScript bug? You console it gently.",
  expressNode: "Why was the JavaScript developer sad? They did not Node how to Express themself.",
  missingGig: "There is a band called 1023MB. They are still waiting for their first gig.",
  oldMacdonald: "Old MacDonald had a farm, but the router kept dropping the E-I-E-I/O.",
  coffeeCompile: "My code compiles on coffee, anxiety, and one suspicious TODO.",
  mergeConflict: "Relationships are easy until somebody tries to resolve a merge conflict by hand.",
  requirements: "The bug was free. The fix required premium requirements.",
  machineLearning: "Machine learning is mostly convincing statistics to wear a hoodie.",
  weekendDeploy: "Never deploy on Friday unless you enjoy recreational firefighting.",
  namingThings: "Naming variables would be simple if every project accepted thingOne through thingFortyTwo.",
  refactorPrayer: "Refactoring is the art of improving code while quietly praying the tests still mean something.",
  cssCenter: "CSS keeps me humble by making centering feel like a spiritual exercise.",
  typoCareer: "A single typo can turn a confident engineer into a part-time archaeologist.",
  commentsTears: "I documented my code with comments and a light trail of emotional damage.",
  aiPair: "AI pair programming is great until both of you become extremely confident about the wrong file.",
  sprintPlan: "A sprint plan is just a carefully scheduled conversation with future surprises.",
  legacyCode: "Legacy code is any code you wrote more than two Tuesdays ago.",
  unitTests: "Unit tests are just tiny trust issues with excellent documentation.",
  dockerWorks: "If it only works in Docker, congratulations, you have containerized your mystery.",
  keyboardShortcut: "Every developer has one keyboard shortcut they hit with faith instead of knowledge.",
  productionTest: "Everyone has a test environment until production volunteers as tribute.",
  regexSpell: "A regex is what happens when a normal string learns forbidden magic.",
  codeReview: "Code review is where style, logic, and mild diplomacy meet in one thread.",
  estimateTruth: "An estimate is the shortest path between optimism and a calendar reminder.",
  dependencyDiet: "My app is on a strict diet of seven lines of code and 1,400 packages.",
  bugFeature: "If enough users depend on it, every bug gets promoted to feature.",
  tabsSpaces: "Tabs versus spaces is less a debate and more a lifelong inheritance of opinions.",
  timeoutTherapy: "Sometimes the healthiest boundary in software is just a shorter timeout.",
  hotfixPoetry: "A hotfix is poetry written directly in the margins of a disaster.",
  rebootWisdom: "The most trusted debugging strategy is still turning it off and pretending that was the plan.",
};

export const pickRandomLandingJoke = () => {
  const jokes = Object.values(LANDING_PAGE_JOKES);
  if (jokes.length === 0) {
    return "";
  }

  const randomValue = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const index = randomValue % jokes.length;
  return jokes[index] ?? jokes[0] ?? "";
};
