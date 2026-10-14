export const newsSourceLibrary=[
  {id:'datron',name:'DATRON USA',url:'https://www.datron.com/feed/',publisher:'DATRON',tier:'primary',topic:'制造与加工',note:'加工工艺、设备与应用，厂商一手视角。'},
  {id:'autodesk-fusion',name:'Autodesk Fusion',url:'https://www.autodesk.com/products/fusion-360/blog/feed/',publisher:'Autodesk',tier:'primary',topic:'制造与加工',note:'CAD/CAM、制造设计与加工应用。'},
  {id:'nvidia-blog',name:'NVIDIA Blog',url:'https://blogs.nvidia.com/feed/',publisher:'NVIDIA',tier:'primary',topic:'电脑与显示',note:'GPU、PC、显示与计算生态，需核查项目适用性。'},
  {id:'windows-blog',name:'Windows Blog',url:'https://blogs.windows.com/feed/',publisher:'Microsoft',tier:'primary',topic:'电脑与显示',note:'Windows、PC 设备和软硬件生态。'},
];
export function newsSearchUrl(query){return 'https://news.google.com/rss/search?'+new URLSearchParams({q:query,hl:'en-US',gl:'US',ceid:'US:en'});}
