/**
 * editor/panels/UIComponents.js
 *
 * Small reusable HTML-string builders shared across editor panels:
 * tabs, label rows, numeric inputs, vec3 inputs, dropdowns, collapsible
 * sections. Editor-only, no runtime dependency.
 */

import { icon } from "../icons/IconLibrary.js";

export function tabBtn(active, label, iconName, extraHtml, dataAction) {
  return (
    '<button class="tab-btn' +
    (active ? " active" : "") +
    '"' +
    (dataAction ? ' data-action="' + dataAction + '"' : "") +
    ">" +
    icon(iconName, 12) +
    "<span>" +
    label +
    "</span>" +
    (extraHtml || "") +
    "</button>"
  );
}

export function row(label, contentHtml) {
  return '<div class="row"><span class="row-label">' + label + '</span><div class="row-content">' + contentHtml + "</div></div>";
}

export function numInput(label, value, dataField, dataAxis) {
  const dataAttrs =
    (dataField ? ' data-field="' + dataField + '"' : "") + (dataAxis ? ' data-axis="' + dataAxis + '"' : "");
  return (
    '<div class="numinput">' +
    (label ? '<span class="axis-label">' + label + "</span>" : "") +
    '<input type="number" value="' + value + '"' + dataAttrs + " />" +
    "</div>"
  );
}

export function vec3Input(x, y, z, dataField) {
  return (
    '<div class="vec3">' +
    numInput("X", x, dataField, "x") +
    numInput("Y", y, dataField, "y") +
    numInput("Z", z, dataField, "z") +
    "</div>"
  );
}

export function dropdownInput(options, selected, dataField) {
  return (
    '<div class="dropdown-input"><select' + (dataField ? ' data-field="' + dataField + '"' : "") + ">" +
    options.map((o) => '<option' + (o === selected ? " selected" : "") + ">" + o + "</option>").join("") +
    "</select>" +
    icon("chevrondown", 10, "chev") +
    "</div>"
  );
}

/**
 * @param {object} sectionsOpen state map of which sections are expanded
 */
export function section(sectionsOpen, key, title, iconName, bodyHtml) {
  const open = sectionsOpen[key] !== false;
  return (
    '<div class="section">' +
    '<div class="section-header">' +
    '<button class="section-toggle" data-action="toggle-section" data-key="' +
    key +
    '">' +
    icon(open ? "chevrondown" : "chevronright", 12) +
    "</button>" +
    '<div class="section-title-row">' +
    '<input type="checkbox" checked />' +
    '<span class="icon-wrap">' +
    icon(iconName, 12) +
    "</span>" +
    "<span>" +
    title +
    "</span>" +
    "</div>" +
    '<button class="section-settings">' +
    icon("settings", 11) +
    "</button>" +
    "</div>" +
    (open ? '<div class="section-body">' + bodyHtml + "</div>" : "") +
    "</div>"
  );
}
