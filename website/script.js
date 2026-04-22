const nav = document.querySelector('.site-nav');

const onScroll = () => {
  nav?.classList.toggle('is-scrolled', window.scrollY > 12);
};

window.addEventListener('scroll', onScroll, { passive: true });
onScroll();
