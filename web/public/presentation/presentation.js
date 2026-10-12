/* Local reveal.js entry point. Deck content is editable in index.html. */
Reveal.initialize({
  width:1280,height:720,margin:0.08,hash:true,controls:true,progress:true,
  slideNumber:slide=>{
    const {h,v}=Reveal.getIndices(slide);
    return [`${h+1}${v?'.'+v:''}`,' / ',document.querySelectorAll('.reveal .slides>section').length];
  },transition:'none',center:true,plugins:[RevealNotes],
});
