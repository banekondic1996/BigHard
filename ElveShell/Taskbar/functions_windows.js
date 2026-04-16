export function getIconsForBar(){
    iconExtractor.emitter.on('icon', function(data)
            {
                RunningProcessList[num].Icon="data:image/png;base64,"+data.Base64ImageData+"";
                refreshBarIcons();                            
            });
}