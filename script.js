// --- Constants & Math Functions ---
const METERS_TO_INCHES = 39.3701;
const METERS_TO_FEET = 3.28084;
const PA_TO_PSI = 6894.757;

const speedOfSound = (T) => Math.sqrt(1.4 * 8.3144598 * T / 0.0289644);

function calculateFlutter(G_psi, cr, ct, b, m, t, P_pa, T_k) {
    const G = G_psi * PA_TO_PSI;
    const kappa = 1.4;
    const t_to_cr = t / cr;
    const lambda = ct / cr;
    const S = (cr + ct) * b / 2;
    const AR = (b ** 2) / S;
    const Cx = (2 * ct * m + ct**2 + m * cr + cr * ct + cr**2) / (3 * (ct + cr));
    const epsilon = (Cx / cr) - 0.25;

    const denom = (24 * epsilon / Math.PI) * ((lambda + 1) / 2) * (Math.pow(AR, 3) / (Math.pow(t_to_cr, 3) * (AR + 2)));
    const finConst = G / denom;
    const a = speedOfSound(T_k);

    return a * Math.sqrt(finConst / (P_pa * kappa));
}

// --- State ---
let simulations = [];
let activeChart = null;

// --- UI Logic ---
const fileInput = document.getElementById('fileInput');
const materialSelect = document.getElementById('material');
const calculateBtn = document.getElementById('calculateBtn');
const simSelector = document.getElementById('simSelector');

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
            document.getElementById('rootChord').value = (parseFloat(finset.getElementsByTagName('rootchord')[0].textContent) * METERS_TO_INCHES).toFixed(3);
            document.getElementById('tipChord').value = (parseFloat(finset.getElementsByTagName('tipchord')[0].textContent) * METERS_TO_INCHES).toFixed(3);
            document.getElementById('semiSpan').value = (parseFloat(finset.getElementsByTagName('height')[0].textContent) * METERS_TO_INCHES).toFixed(3);
            document.getElementById('sweep').value = (parseFloat(finset.getElementsByTagName('sweeplength')[0].textContent) * METERS_TO_INCHES).toFixed(3);
            document.getElementById('thickness').value = (parseFloat(finset.getElementsByTagName('thickness')[0].textContent) * METERS_TO_INCHES).toFixed(3);
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
                    alt: point['Altitude above sea level'] * METERS_TO_FEET,
                    vel: point['Vertical velocity'] * METERS_TO_FEET,
                    pres: point['Air pressure'], 
                    temp: point['Air temperature'] 
                });
            }
            if (dataPoints.length > 0) simulations.push({ name, data: dataPoints });
        }

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

function runAnalysis() {
    const simIdx = simSelector.value;
    if (!simulations[simIdx]) return;

    const G = materialSelect.value === 'custom' ? parseFloat(document.getElementById('customG').value) : parseFloat(materialSelect.value);
    const cr = parseFloat(document.getElementById('rootChord').value);
    const ct = parseFloat(document.getElementById('tipChord').value);
    const b = parseFloat(document.getElementById('semiSpan').value);
    const m = parseFloat(document.getElementById('sweep').value);
    const t = parseFloat(document.getElementById('thickness').value);

    const rawData = simulations[simIdx].data;
    const processed = [];
    let minMargin = Infinity;
    let minPoint = null;

    for (let i = 0; i < rawData.length; i++) {
        if (i > 0 && rawData[i].alt < rawData[i-1].alt) break;

        const flutterVel = calculateFlutter(G, cr, ct, b, m, t, rawData[i].pres, rawData[i].temp) * METERS_TO_FEET;
        const margin = flutterVel - rawData[i].vel;
        const marginPercent = (margin / flutterVel) * 100;

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

    alertBox.innerHTML = `<strong>Min Margin: ${min.marginPercent.toFixed(0)}% (${min.margin.toFixed(1)} ft/s)</strong> at ${min.alt.toFixed(0)} ft altitude (Velocity: ${min.vel.toFixed(1)} ft/s)`;

    const ctx = document.getElementById('flutterChart').getContext('2d');
    if (activeChart) activeChart.destroy();

    activeChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.time.toFixed(2)),
            datasets: [
                {
                    label: 'Velocity (ft/s)',
                    data: data.map(d => d.velocity),
                    borderColor: '#3b82f6',
                    tension: 0.1,
                    pointRadius: 0,
                    yAxisID: 'y'
                },
                {
                    label: 'Flutter Velocity (ft/s)',
                    data: data.map(d => d.flutter),
                    borderColor: '#f97316',
                    tension: 0.1,
                    pointRadius: 0,
                    yAxisID: 'y'
                },
                {
                    label: 'Margin (ft/s)',
                    data: data.map(d => d.margin),
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
                    title: { display: true, text: 'Velocity (ft/s)' },
                    position: 'left'
                }
            }
        }
    });
}