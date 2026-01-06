import React, { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Upload, AlertCircle, FileText, ChevronDown, ChevronUp } from 'lucide-react';

const FinFlutterAnalyzer = () => {
  const [finParams, setFinParams] = useState({
    shearModulus: '',
    rootChord: '',
    tipChord: '',
    semiSpan: '',
    sweepLength: '',
    thickness: ''
  });
  
  const [materialPreset, setMaterialPreset] = useState('g10');
  const [csvData, setCsvData] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [simulations, setSimulations] = useState([]);
  const [selectedSim, setSelectedSim] = useState(0);

  const materials = {
    'balsa': { name: 'Balsa Wood', value: '33359' },
    'birch': { name: 'Birch Plywood', value: '89000' },
    'g10': { name: 'G10/G12 Fiberglass', value: '600000' },
    'carbon': { name: 'Carbon Fiber', value: '600000' },
    'aluminum': { name: '6061-T6 Aluminum', value: '3800000' },
    'titanium': { name: 'Ti-6Al-4V Titanium', value: '6200000' },
    'steel': { name: '4130 Steel', value: '12000000' },
    'custom': { name: 'Custom', value: '' }
  };

  // Set default material on mount
  React.useEffect(() => {
    if (!finParams.shearModulus) {
      setFinParams(prev => ({ ...prev, shearModulus: materials.g10.value }));
    }
  }, []);

  const speedOfSound = (T, kappa = 1.4, R = 8.3144598, M = 0.0289644) => {
    return Math.sqrt(kappa * R * T / M);
  };

  const flutterVelocityTrapezoidal = (G, T2T, c_r, c_t, b, m, t, P, T) => {
    const kappa = 1.4;
    const t_to_c_r = t / c_r;
    const lambda = c_t / c_r;
    const S = (c_r + c_t) * b / 2;
    const AR = (b ** 2) / S;
    const C_x = (2 * c_t * m + c_t ** 2 + m * c_r + c_r * c_t + c_r ** 2) / (3 * (c_t + c_r));
    const epsilon = C_x / c_r - 0.25;
    
    const denom_const = 24 * epsilon / Math.PI * (lambda + 1) / 2 * (AR ** 3 / (t_to_c_r ** 3 * (AR + 2)));
    let fin_const = G / denom_const;
    
    if (T2T) {
      fin_const *= 2;
    }
    
    const a = speedOfSound(T, kappa);
    return a * Math.sqrt(fin_const / (P * kappa));
  };

  const parseORKFile = async (file) => {
    try {
      // Load JSZip from CDN
      if (!window.JSZip) {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      
      const zip = await window.JSZip.loadAsync(file);
      const xmlFile = zip.file(/\.ork$/i)[0] || zip.file(/\.xml$/i)[0];
      
      if (!xmlFile) {
        throw new Error('No .ork or .xml file found in the archive');
      }
      
      const xmlText = await xmlFile.async('string');
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
      
      // Extract fin parameters from the first trapezoidal fin set
      const finsets = xmlDoc.getElementsByTagName('trapezoidfinset');
      if (finsets.length === 0) {
        throw new Error('No trapezoidal fin set found in OpenRocket file');
      }
      
      const finset = finsets[0];
      
      // Convert meters to inches (OpenRocket uses meters)
      const metersToInches = 39.3701;
      
      const rootChord = parseFloat(finset.getElementsByTagName('rootchord')[0]?.textContent || 0) * metersToInches;
      const tipChord = parseFloat(finset.getElementsByTagName('tipchord')[0]?.textContent || 0) * metersToInches;
      const height = parseFloat(finset.getElementsByTagName('height')[0]?.textContent || 0) * metersToInches;
      const sweepLength = parseFloat(finset.getElementsByTagName('sweeplength')[0]?.textContent || 0) * metersToInches;
      const thickness = parseFloat(finset.getElementsByTagName('thickness')[0]?.textContent || 0) * metersToInches;
      
      setFinParams(prev => ({
        ...prev,
        rootChord: rootChord.toFixed(4),
        tipChord: tipChord.toFixed(4),
        semiSpan: height.toFixed(4),
        sweepLength: sweepLength.toFixed(4),
        thickness: thickness.toFixed(4)
      }));
      
      // Extract all simulations
      const simulationElements = xmlDoc.getElementsByTagName('simulation');
      const simList = [];
      
      for (let s = 0; s < simulationElements.length; s++) {
        const sim = simulationElements[s];
        const name = sim.getElementsByTagName('name')[0]?.textContent || `Simulation ${s + 1}`;
        
        const flightdata = sim.getElementsByTagName('flightdata');
        if (flightdata.length > 0) {
          const databranches = flightdata[0].getElementsByTagName('databranch');
          if (databranches.length > 0) {
            // Try to find the branch with actual flight data
            for (let b = 0; b < databranches.length; b++) {
              const branch = databranches[b];
              const branchName = branch.getAttribute('name') || '';
              const datapoints = branch.getElementsByTagName('datapoint');
              const simData = [];
              
              // Debug: Check what we're actually getting
              if (datapoints.length > 0) {
                const firstPoint = datapoints[0];
                console.log('First datapoint element:', firstPoint);
                console.log('All child nodes:', Array.from(firstPoint.childNodes).map(n => ({name: n.nodeName, value: n.textContent})));
              }
              
              // OpenRocket stores data differently - look for the actual structure
              for (let i = 0; i < datapoints.length; i++) {
                const point = datapoints[i];
                
                // OpenRocket typically stores values in child elements with type attributes
                let time = 0, altitude = 0, velocity = 0, pressure = 101325, temperature = 288.15;
                
                // Try to find values by type attribute
                const children = point.children;
                for (let j = 0; j < children.length; j++) {
                  const child = children[j];
                  const type = child.getAttribute('type');
                  const value = parseFloat(child.textContent || child.getAttribute('value') || 0);
                  
                  if (type === 'time' || child.nodeName === 'time') time = value;
                  else if (type === 'altitude' || child.nodeName === 'altitude') altitude = value;
                  else if (type === 'velocity' || child.nodeName === 'velocity' || type === 'velocitytotal') velocity = value;
                  else if (type === 'pressure' || child.nodeName === 'pressure') pressure = value;
                  else if (type === 'temperature' || child.nodeName === 'temperature') temperature = value;
                }
                
                const dataPoint = {
                  time: time,
                  altitude: altitude * 3.28084, // m to ft
                  velocity: velocity * 3.28084, // m/s to ft/s
                  pressure: pressure / 6894.757, // Pa to psi
                  temperature: temperature // K
                };
                
                simData.push(dataPoint);
              }
              
              // Debug: log first few points
              if (simData.length > 0) {
                console.log('Sample data points:', simData.slice(0, 3));
                console.log('Last data point:', simData[simData.length - 1]);
                console.log('Total points in this branch:', simData.length);
              }
              
              if (simData.length > 0) {
                simList.push({ name: `${name} - ${branchName}`.trim(), data: simData });
                break; // Take first valid branch
              }
            }
          }
        }
      }
      
      if (simList.length > 0) {
        setSimulations(simList);
        setSelectedSim(0);
        setCsvData(simList[0].data);
        setFileInfo(`Loaded fin parameters and ${simList.length} simulation(s) from .ork file`);
      } else {
        setFileInfo('Fin parameters loaded. No simulation data found in .ork file.');
        console.log('No valid simulation data found. Check if simulations exist in the .ork file.');
      }
      
      setError(null);
      
    } catch (err) {
      setError('Error parsing .ork file: ' + err.message);
      console.error('Full error:', err);
    }
  };

  const handleORKUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    setError(null);
    setFileInfo('Loading .ork file...');
    
    await parseORKFile(file);
  };

  const handleCSVUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const lines = text.split('\n');
        const headers = lines[0].split(',').map(h => h.trim());
        
        const data = [];
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].trim()) {
            const values = lines[i].split(',');
            const row = {};
            headers.forEach((header, index) => {
              row[header] = parseFloat(values[index]) || 0;
            });
            data.push(row);
          }
        }
        
        setCsvData(data);
        setSimulations([]);
        setFileInfo(`Loaded ${data.length} data points from CSV`);
        setError(null);
      } catch (err) {
        setError('Error parsing CSV file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  const handleSimulationChange = (index) => {
    setSelectedSim(index);
    setCsvData(simulations[index].data);
    setResults(null);
  };

  const handleInputChange = (field, value) => {
    setFinParams(prev => ({ ...prev, [field]: value }));
  };

  const handleMaterialChange = (materialKey) => {
    setMaterialPreset(materialKey);
    if (materialKey !== 'custom') {
      setFinParams(prev => ({ ...prev, shearModulus: materials[materialKey].value }));
    }
  };

  const calculateResults = () => {
    if (!csvData) {
      setError('Please upload a file with simulation data.');
      return;
    }

    // Check for empty string values and log them for debugging
    const requiredParams = ['shearModulus', 'rootChord', 'tipChord', 'semiSpan', 'sweepLength', 'thickness'];
    const missingParams = [];
    
    for (const param of requiredParams) {
      const value = finParams[param];
      if (!value || value === '' || isNaN(parseFloat(value))) {
        missingParams.push(param);
      }
    }
    
    if (missingParams.length > 0) {
      setError(`Please fill in all fin parameters. Missing or invalid: ${missingParams.join(', ')}`);
      return;
    }

    try {
      const G = parseFloat(finParams.shearModulus) * 6894.757; // psi to Pa
      const c_r = parseFloat(finParams.rootChord);
      const c_t = parseFloat(finParams.tipChord);
      const b = parseFloat(finParams.semiSpan);
      const m = parseFloat(finParams.sweepLength);
      const t = parseFloat(finParams.thickness);

      // Filter data up to apogee
      const filteredData = [];
      for (let i = 0; i < csvData.length; i++) {
        if (i === 0 || csvData[i].altitude >= csvData[i - 1].altitude) {
          filteredData.push(csvData[i]);
        } else {
          break;
        }
      }

      // Calculate flutter velocity for each data point
      const processedData = filteredData.map(row => {
        const P = row.pressure * 6894.757; // psi to Pa
        const T = row.temperature; // K
        
        const flutterVel = flutterVelocityTrapezoidal(G, false, c_r, c_t, b, m, t, P, T) * 3.28084; // m/s to ft/s
        const margin = flutterVel - row.velocity;
        
        return {
          time: row.time,
          velocity: row.velocity,
          flutterVelocity: flutterVel,
          margin: margin,
          altitude: row.altitude
        };
      });

      // Find minimum margin
      const minMarginPoint = processedData.reduce((min, point) => 
        point.margin < min.margin ? point : min
      );

      setResults({
        data: processedData,
        minMargin: minMarginPoint
      });
      setError(null);
    } catch (err) {
      setError('Error calculating results: ' + err.message);
    }
  };

  const FinOutline = () => {
    if (!finParams.rootChord || !finParams.tipChord || !finParams.semiSpan || !finParams.sweepLength) {
      return null;
    }

    const c_r = parseFloat(finParams.rootChord);
    const c_t = parseFloat(finParams.tipChord);
    const b = parseFloat(finParams.semiSpan);
    const m = parseFloat(finParams.sweepLength);

    // Scale factor for display
    const scale = 40;
    const width = (Math.max(c_r, m + c_t) * scale) + 40;
    const height = (b * scale) + 40;

    // Define fin points (trapezoid)
    const points = [
      [20, height - 20], // Bottom left (root leading edge)
      [20 + c_r * scale, height - 20], // Bottom right (root trailing edge)
      [20 + m * scale + c_t * scale, 20], // Top right (tip trailing edge)
      [20 + m * scale, 20] // Top left (tip leading edge)
    ];

    const pathData = `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]} L ${points[2][0]} ${points[2][1]} L ${points[3][0]} ${points[3][1]} Z`;

    return (
      <div className="mt-6 bg-gray-50 p-4 rounded-lg border border-gray-200">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Fin Profile</h3>
        <svg width={width} height={height} className="mx-auto">
          <path d={pathData} fill="#3B82F6" fillOpacity="0.3" stroke="#3B82F6" strokeWidth="2"/>
          
          {/* Dimension lines */}
          <line x1="20" y1={height - 20} x2={20 + c_r * scale} y2={height - 20} stroke="#EF4444" strokeWidth="1" strokeDasharray="3,3"/>
          <text x={20 + (c_r * scale) / 2} y={height - 25} textAnchor="middle" fontSize="10" fill="#EF4444">Root: {c_r.toFixed(2)}"</text>
          
          <line x1={20 + m * scale} y1="20" x2={20 + m * scale + c_t * scale} y2="20" stroke="#10B981" strokeWidth="1" strokeDasharray="3,3"/>
          <text x={20 + m * scale + (c_t * scale) / 2} y="15" textAnchor="middle" fontSize="10" fill="#10B981">Tip: {c_t.toFixed(2)}"</text>
          
          <line x1="20" y1={height - 20} x2="20" y2="20" stroke="#F59E0B" strokeWidth="1" strokeDasharray="3,3"/>
          <text x="10" y={(height - 20 + 20) / 2} textAnchor="middle" fontSize="10" fill="#F59E0B" transform={`rotate(-90, 10, ${(height - 20 + 20) / 2})`}>Span: {b.toFixed(2)}"</text>
        </svg>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold text-indigo-900 mb-2">Fin Flutter Velocity Analyzer</h1>
        <p className="text-gray-600 mb-8">Upload OpenRocket file (.ork) to auto-fill parameters and analyze fin flutter</p>

        <div className="grid md:grid-cols-2 gap-6 mb-8">
          {/* Input Panel */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">Fin Parameters</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Fin Material <span className="text-red-500">*</span>
                </label>
                <select
                  value={materialPreset}
                  onChange={(e) => handleMaterialChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                >
                  <option value="balsa">Balsa Wood (33,359 psi)</option>
                  <option value="birch">Birch Plywood (89,000 psi)</option>
                  <option value="g10">G10/G12 Fiberglass (600,000 psi)</option>
                  <option value="carbon">Carbon Fiber (600,000 psi)</option>
                  <option value="aluminum">6061-T6 Aluminum (3,800,000 psi)</option>
                  <option value="titanium">Ti-6Al-4V Titanium (6,200,000 psi)</option>
                  <option value="steel">4130 Steel (12,000,000 psi)</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              {materialPreset === 'custom' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Custom Shear Modulus (psi)
                  </label>
                  <input
                    type="number"
                    value={finParams.shearModulus}
                    onChange={(e) => handleInputChange('shearModulus', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    placeholder="e.g., 500000"
                  />
                </div>
              )}

              <button
                onClick={() => setShowManualEntry(!showManualEntry)}
                className="flex items-center justify-between w-full px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors text-sm font-medium text-gray-700"
              >
                <span>Manual Entry & CSV Upload (Optional)</span>
                {showManualEntry ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {showManualEntry && (
                <div className="space-y-4 pl-4 border-l-2 border-gray-200">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Root Chord (in)</label>
                    <input
                      type="number"
                      step="any"
                      value={finParams.rootChord}
                      onChange={(e) => handleInputChange('rootChord', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      placeholder="Auto-filled from .ork"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Tip Chord (in)</label>
                    <input
                      type="number"
                      step="any"
                      value={finParams.tipChord}
                      onChange={(e) => handleInputChange('tipChord', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      placeholder="Auto-filled from .ork"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Semi-Span (in)</label>
                    <input
                      type="number"
                      step="any"
                      value={finParams.semiSpan}
                      onChange={(e) => handleInputChange('semiSpan', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      placeholder="Auto-filled from .ork"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Sweep Length (in)</label>
                    <input
                      type="number"
                      step="any"
                      value={finParams.sweepLength}
                      onChange={(e) => handleInputChange('sweepLength', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      placeholder="Auto-filled from .ork"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Thickness (in)</label>
                    <input
                      type="number"
                      step="any"
                      value={finParams.thickness}
                      onChange={(e) => handleInputChange('thickness', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      placeholder="Auto-filled from .ork"
                    />
                  </div>

                  <div className="pt-4 border-t border-gray-200">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Upload CSV (Alternative to .ork sim data)</label>
                    <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-indigo-500 transition-colors">
                      <Upload className="mx-auto h-8 w-8 text-gray-400 mb-2" />
                      <label className="cursor-pointer">
                        <span className="text-indigo-600 hover:text-indigo-700 font-medium text-sm">Upload CSV file</span>
                        <input
                          type="file"
                          accept=".csv"
                          onChange={handleCSVUpload}
                          className="hidden"
                        />
                      </label>
                      <p className="text-xs text-gray-500 mt-1">
                        time, altitude, velocity, pressure, temperature
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <FinOutline />
          </div>

          {/* File Upload Panel */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">Upload OpenRocket File</h2>
            
            <div className="border-2 border-dashed border-indigo-300 rounded-lg p-6 text-center hover:border-indigo-500 transition-colors bg-indigo-50">
              <FileText className="mx-auto h-10 w-10 text-indigo-600 mb-3" />
              <label className="cursor-pointer">
                <span className="text-indigo-600 hover:text-indigo-700 font-medium text-lg">Upload .ork file</span>
                <input
                  type="file"
                  accept=".ork"
                  onChange={handleORKUpload}
                  className="hidden"
                />
              </label>
              <p className="text-sm text-gray-600 mt-2">
                OpenRocket file - auto-fills fin parameters and simulation data
              </p>
            </div>

            {simulations.length > 1 && (
              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Select Simulation</label>
                <select
                  value={selectedSim}
                  onChange={(e) => handleSimulationChange(parseInt(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                >
                  {simulations.map((sim, index) => (
                    <option key={index} value={index}>
                      {sim.name} ({sim.data.length} points)
                    </option>
                  ))}
                </select>
              </div>
            )}

            {fileInfo && (
              <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-md">
                <p className="text-green-800">✓ {fileInfo}</p>
              </div>
            )}

            <button
              onClick={calculateResults}
              className="w-full mt-6 bg-indigo-600 text-white py-3 px-4 rounded-md hover:bg-indigo-700 transition-colors font-medium"
            >
              Calculate Flutter Velocity
            </button>

            {error && (
              <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-md flex items-start">
                <AlertCircle className="h-5 w-5 text-red-600 mr-2 flex-shrink-0 mt-0.5" />
                <p className="text-red-800 text-sm">{error}</p>
              </div>
            )}
          </div>
        </div>

        {/* Results */}
        {results && (
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">Results</h2>
            
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
              <h3 className="font-semibold text-yellow-900 mb-2">Minimum Margin</h3>
              <p className="text-yellow-800">
                <strong>{results.minMargin.margin.toFixed(2)} ft/s</strong> at {results.minMargin.altitude.toFixed(2)} ft altitude, 
                going {results.minMargin.velocity.toFixed(2)} ft/s at t={results.minMargin.time.toFixed(2)}s
              </p>
            </div>

            <ResponsiveContainer width="100%" height={400}>
              <LineChart data={results.data} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="time" label={{ value: 'Time (s)', position: 'insideBottom', offset: -5 }} />
                <YAxis yAxisId="left" label={{ value: 'Velocity (ft/s)', angle: -90, position: 'insideLeft' }} />
                <YAxis yAxisId="right" orientation="right" label={{ value: 'Margin (ft/s)', angle: 90, position: 'insideRight' }} />
                <Tooltip />
                <Legend />
                <Line yAxisId="left" type="monotone" dataKey="velocity" stroke="#3B82F6" name="Velocity" dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="flutterVelocity" stroke="#F97316" name="Flutter Velocity" dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="margin" stroke="#10B981" name="Margin" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
};

export default FinFlutterAnalyzer;