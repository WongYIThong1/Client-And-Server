export function colorBanner() {
  const banner = `
   _____  ____  _     ____        _        
  / ____|/ __ \| |   / __ \      | |       
 | (___ | |  | | | _| |  | |_   _| | ___   
  \___ \| |  | | |/ / |  | | | | | |/ _ \  
  ____) | |__| |   <| |__| | |_| | |  __/  
 |_____/ \____/|_|\_\\____/ \__,_|_|\___|  
`;
  const cyan = '\u001b[36m';
  const bold = '\u001b[1m';
  const reset = '\u001b[0m';
  console.log(`${cyan}${bold}${banner}${reset}`);
}
