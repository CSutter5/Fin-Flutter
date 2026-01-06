// --- Constants & Math Functions ---
const METERS_TO_INCHES = 39.3701;
const METERS_TO_CENTIMETER = 100.0;
const METERS_SEC_TO_FT_SEC = 3.28084;
const METERS_TO_FEET = 3.28084;
const PA_TO_PSI = 6894.757;
const PA_TO_KPA = 0.001;

const KAPPA = 1.4;

function calculateFlutter(shearModulus, rootChord, tipChord, semiSpan, sweep, thickness, alt) {
    shearModulus = shearModulus * 6.894757;

    rootChord = rootChord * METERS_TO_CENTIMETER;
    tipChord = tipChord * METERS_TO_CENTIMETER;
    semiSpan = semiSpan * METERS_TO_CENTIMETER;
    sweep = sweep * METERS_TO_CENTIMETER;
    thickness = thickness * METERS_TO_CENTIMETER;

    const Cx = ((2*tipChord*sweep)+(tipChord*tipChord)+(sweep*rootChord)+(tipChord*rootChord)+(rootChord*rootChord))/(3*(tipChord+rootChord))

    const thicknessRatio = thickness / rootChord;
    const lambda = tipChord / rootChord;
    const finArea = (rootChord + tipChord) * semiSpan / 2;
    const aspectRatio = (semiSpan ** 2) / finArea;
    const epsilon = (Cx / rootChord) - 0.25;
    const denom = (24 * epsilon * KAPPA * startingPressure) / Math.PI;
    const Tc = startingTempurature - (0.0065 * alt)
    const a = 20.05 * Math.sqrt(273.13 + Tc);
    const p = startingPressure * ((Tc + 273.16)/(startingTempurature+273.16))**5.256;
    
    const firstTerm = (denom * aspectRatio**3)/((thicknessRatio)**3 * (aspectRatio + 2))
    const secondTerm = (lambda+1)/2
    const thirdTerm = p/startingPressure;

    return a * Math.sqrt((shearModulus)/(firstTerm * secondTerm * thirdTerm));
}

// --- State ---
let simulations = [];
let activeChart = null;

let useMetric = true;

let finRootChord = 0;
let finTipChord = 0;
let finSemiSpan = 0;
let finSweep = 0;
let finThickness = 0;

let startingPressure;
let startingTempurature;

let simRan = false;

// --- UI Logic ---
const fileInput = document.getElementById('fileInput');
const materialSelect = document.getElementById('material');
const calculateBtn = document.getElementById('calculateBtn');
const simSelector = document.getElementById('simSelector');
const unitSelector = document.getElementById('unitSelector');

materialSelect.addEventListener('change', (e) => {
    document.getElementById('customGContainer').classList.toggle('hidden', e.target.value !== 'custom');
});

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('fileName').textContent = file.name;

    try {
        const zip = await JSZip.loadAsync(file);
        const orkFile = Object.values(zip.files).find(f => f.name.endsWith('.ork') || f.name.endsWith('.xml'));
        const xmlText = await orkFile.async('string');
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

        // 1. Extract Fin Params
        const finset = xmlDoc.getElementsByTagName('trapezoidfinset')[0];
        if (finset) {
            finRootChord = parseFloat(finset.getElementsByTagName('rootchord')[0].textContent);
            finTipChord = parseFloat(finset.getElementsByTagName('tipchord')[0].textContent);
            finSemiSpan = parseFloat(finset.getElementsByTagName('height')[0].textContent);
            finSweep = parseFloat(finset.getElementsByTagName('sweeplength')[0].textContent);
            finThickness = parseFloat(finset.getElementsByTagName('thickness')[0].textContent);

            updateUnits();
        }

        // 2. Extract Simulations
        simulations = [];
        const simNodes = xmlDoc.getElementsByTagName('simulation');
        for (let sim of simNodes) {
            const name = sim.getElementsByTagName('name')[0]?.textContent || "Unnamed Sim";
            const dataPoints = [];
            const points = sim.getElementsByTagName('datapoint');

            const headers = sim.getElementsByTagName('databranch')[0]?.getAttribute('types')?.split(',').map(h => h.trim());

            for (let p of points) {
                let data = p.innerHTML; 
                let values = data.split(',').map(v => v.trim());
                let point = {};

                headers.forEach((h, i) => {
                    point[h] = parseFloat(values[i]);
                });

                dataPoints.push({
                    time: point['Time'],
                    alt: point['Altitude above sea level'],
                    vel: point['Vertical velocity'],
                    pres: point['Air pressure'], 
                    temp: point['Air temperature'] 
                });
            }
            if (dataPoints.length > 0) simulations.push({ name, data: dataPoints });
        }

        startingPressure = simulations[0]["data"][0]["pres"] * PA_TO_KPA;
        startingTempurature = simulations[0]["data"][0]["temp"] - 272.15;

        if (simulations.length > 0) {
            document.getElementById('simSelectorContainer').classList.remove('hidden');
            simSelector.innerHTML = simulations.map((s, i) => `<option value="${i}">${s.name}</option>`).join('');
            runAnalysis();
        }

    } catch (err) {
        alert("Error reading file: " + err.message);
    }
});

calculateBtn.addEventListener('click', runAnalysis);
simSelector.addEventListener('change', runAnalysis);
unitSelector.addEventListener('change', updateUnits)

function runAnalysis() {
    const simIdx = simSelector.value;
    if (!simulations[simIdx]) return;

    const shearModulus = materialSelect.value === 'custom' ? parseFloat(document.getElementById('customG').value) : parseFloat(materialSelect.value);

    const rawData = simulations[simIdx].data;
    const processed = [];
    let minMargin = Infinity;
    let minPoint = null;

    for (let i = 0; i < rawData.length; i++) {
        if (i > 0 && rawData[i].alt < rawData[i-1].alt) break;

        const flutterVel = calculateFlutter(
            shearModulus, finRootChord, finTipChord, 
            finSemiSpan, finSweep, finThickness, rawData[i].alt
        );

        const margin = flutterVel - rawData[i].vel;
        const marginPercent = (margin / rawData[i].vel) * 100;

        if (margin < minMargin) {
            minMargin = margin;
            minPoint = { ...rawData[i], flutterVel, margin, marginPercent };
        }

        processed.push({
            time: rawData[i].time,
            velocity: rawData[i].vel,
            flutter: flutterVel,
            margin: margin,
            marginPercent: marginPercent
        });
    }

    simRan = true;

    updateUI(processed, minPoint);
}

function updateUI(data, min) {
    document.getElementById('resultsCard').classList.remove('hidden');
    document.getElementById('statusPlaceholder').classList.add('hidden');

    const alertBox = document.getElementById('minMarginAlert');
    
    if (min.marginPercent < 20) {
        alertBox.className = "p-4 rounded-lg bg-red-50 text-red-800 border border-red-100 mb-6";
    } else if (min.marginPercent < 30) {
        alertBox.className = "p-4 rounded-lg bg-yellow-50 text-yellow-800 border border-yellow-100 mb-6";
    } else {
        alertBox.className = "p-4 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-100 mb-6";
    }

    let velocityUnit = useMetric ? "m/s" : "ft/s";
    let velocityMultiplier = useMetric ? 1 : METERS_SEC_TO_FT_SEC;

    let altitudeUnit = useMetric ? "m" : "ft";
    let altitudeMultiplier = useMetric ? 1 : METERS_TO_FEET;

    alertBox.innerHTML = `<strong>Min Margin: ${min.marginPercent.toFixed(0)}% (${(min.margin * velocityMultiplier).toFixed(1)} ${velocityUnit})</strong> at ${(min.alt * altitudeMultiplier).toFixed(0)} ${altitudeUnit} altitude (Velocity: ${(min.vel * velocityMultiplier).toFixed(1)} ${velocityUnit})`;

    const ctx = document.getElementById('flutterChart').getContext('2d');
    if (activeChart) activeChart.destroy();

    activeChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.time.toFixed(2)),
            datasets: [
                {
                    label: `Velocity (${velocityUnit})`,
                    data: data.map(d => d.velocity * velocityMultiplier),
                    borderColor: '#3b82f6',
                    tension: 0.1,
                    pointRadius: 0,
                    yAxisID: 'y'
                },
                {
                    label: `Flutter Velocity (${velocityUnit})`,
                    data: data.map(d => d.flutter * velocityMultiplier),
                    borderColor: '#f97316',
                    tension: 0.1,
                    pointRadius: 0,
                    yAxisID: 'y'
                },
                {
                    label: `Margin (${velocityUnit})`,
                    data: data.map(d => d.margin * velocityMultiplier),
                    borderColor: '#10b981',
                    tension: 0.1,
                    pointRadius: 0,
                    yAxisID: 'y'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { title: { display: true, text: 'Time (s)' } },
                y: {
                    title: { display: true, text: `Velocity (${velocityUnit})` },
                    position: 'left'
                }
            }
        }
    });
}

function updateUnits()
{

    useMetric = unitSelector.value == 'metric'

    const unitMultiplier = useMetric ? METERS_TO_CENTIMETER : METERS_TO_INCHES;
    const distanceUnit = useMetric ? "mm" : "in";

    document.getElementById('rootChordUnit').innerHTML = distanceUnit;
    document.getElementById('tipChordUnit').innerHTML = distanceUnit;
    document.getElementById('semiSpanUnit').innerHTML = distanceUnit;
    document.getElementById('sweepUnit').innerHTML = distanceUnit;
    document.getElementById('thicknessUnit').innerHTML = distanceUnit;


    document.getElementById('rootChord').value = (finRootChord * unitMultiplier).toFixed(3);
    document.getElementById('tipChord').value = (finTipChord * unitMultiplier).toFixed(3);
    document.getElementById('semiSpan').value = (finSemiSpan * unitMultiplier).toFixed(3);
    document.getElementById('sweep').value = (finSweep * unitMultiplier).toFixed(3);
    document.getElementById('thickness').value = (finThickness * unitMultiplier).toFixed(3);


    if (simRan) runAnalysis();
}