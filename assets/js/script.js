'use strict';

document.documentElement.classList.add("js");

/**
 * add event on multiple elements
 */

const addEventOnElements = function (elements, eventType, callback) {
  for (let i = 0, len = elements.length; i < len; i++) {
    elements[i].addEventListener(eventType, callback);
  }
};



/**
 * Mobile navbar toggle
 */

const navbar = document.querySelector("[data-navbar]");
const navTogglers = document.querySelectorAll("[data-nav-toggler]");
const navLinks = document.querySelectorAll("[data-nav-link]");
const overlay = document.querySelector("[data-overlay]");

addEventOnElements(navTogglers, "click", function () {
  navbar.classList.toggle("active");
  overlay.classList.toggle("active");
  document.body.classList.toggle("nav-active");
});

addEventOnElements(navLinks, "click", function () {
  navbar.classList.remove("active");
  overlay.classList.remove("active");
  document.body.classList.remove("nav-active");
});



/**
 * Header state on scroll
 */

const header = document.querySelector("[data-header]");

window.addEventListener("scroll", function () {
  header.classList[window.scrollY > 60 ? "add" : "remove"]("active");
});



/**
 * Scroll reveal
 */

const revealElements = document.querySelectorAll("[data-reveal]");

if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    function (entries, observer) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );

  revealElements.forEach(function (el) {
    revealObserver.observe(el);
  });
} else {
  revealElements.forEach(function (el) {
    el.classList.add("in-view");
  });
}



/**
 * Active nav link on scroll
 */

const sections = document.querySelectorAll("main section[id], .hero[id]");

if ("IntersectionObserver" in window && sections.length) {
  const navObserver = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        const link = document.querySelector(`.navbar-link[href="#${entry.target.id}"]`);
        if (!link) return;
        if (entry.isIntersecting) {
          navLinks.forEach(function (l) { l.classList.remove("active"); });
          link.classList.add("active");
        }
      });
    },
    { rootMargin: "-45% 0px -45% 0px" }
  );

  sections.forEach(function (section) {
    navObserver.observe(section);
  });
}



/**
 * FAQ accordion — only one item open at a time
 */

const faqItems = document.querySelectorAll(".faq-item");

addEventOnElements(faqItems, "toggle", function () {
  if (!this.open) return;
  faqItems.forEach(function (item) {
    if (item !== this) item.open = false;
  }, this);
});
