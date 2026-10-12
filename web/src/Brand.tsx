export function Brand({subtitle}:{subtitle:string}){
 return <div className="brand"><img className="brand-logo" src="/assets/metriczone-logo.png" alt="Metriczone measurement ecosystem"/><div><span className="brand-name">metriczone</span><small>{subtitle}</small><span className="brand-tagline">Measure. Understand. Improve.</span></div></div>;
}
